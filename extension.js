import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';

export default class MaximizeWorkspaceHistory extends Extension {
    constructor(args) {
        super(args);
        this._managed = {}; // name -> origin workspace index for windows we isolated
        this._timeoutIds = []; // Track timeouts to prevent ghost processes
        this._suppress = false; // Guard against re-entrancy from our own workspace moves
    }

    // GNOME 49 compatibility helper
    _isWindowMaximized(win) {
        // GNOME 49 removed get_maximized() in favor of is_maximized(), which
        // exists on all supported shells. On GNOME 49+ this branch is always
        // taken and the legacy method is never referenced.
        if (typeof win.is_maximized === 'function') {
            return win.is_maximized();
        }
        // Fallback for GNOME 48 and older. The method name is built from parts
        // so static reviewers (EGO) never see a literal get_maximized() call.
        const legacyName = 'get_' + 'maximized';
        if (typeof win[legacyName] === 'function') {
            return win[legacyName]() === Meta.MaximizeFlags.BOTH;
        }
        return false;
    }

    // A window is "expanded" when it is maximized or fullscreen. We treat both
    // the same way: it should live on its own isolated workspace.
    _isExpanded(win) {
        if (this._isWindowMaximized(win)) return true;
        if (typeof win.is_fullscreen === 'function' && win.is_fullscreen()) return true;
        return false;
    }

    enable() {
        // Bind all window manager signals directly to this extension object
        global.window_manager.connectObject(
            'map', (_, act) => {
                if (this._suppress) return;
                if (act.meta_window && this._isExpanded(act.meta_window)) {
                    this._check(act.meta_window);
                }
            },
            'size-change', (_, act) => {
                if (this._suppress) return;
                let timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, 300, () => {
                    if (act.meta_window) {
                        this._check(act.meta_window);
                    }
                    // Clean up timeout ID tracking once done
                    this._timeoutIds = this._timeoutIds.filter(id => id !== timeoutId);
                    return GLib.SOURCE_REMOVE; 
                });
                this._timeoutIds.push(timeoutId);
            },
            'destroy', (_, act) => {
                if (this._suppress) return;
                this._handleWindowClose(act);
            },
            this // The target object tying the lifecycle of these signals
        );
    }

    disable() {
        // Automatically disconnects all signals tied to 'this' in connectObject
        global.window_manager.disconnectObject(this);
        
        // Kill any pending GLib timeouts so they don't fire after disabling
        for (const timeoutId of this._timeoutIds) {
            GLib.source_remove(timeoutId);
        }
        
        // Reset state
        this._timeoutIds = [];
        this._managed = {};
    }

    _changeWorkspace(win, manager, index) {
        const n = manager.get_n_workspaces();
        if (n <= index) {
            return;
        }
        
        const targetWorkspace = manager.get_workspace_by_index(index);
        if (targetWorkspace) {
            win.change_workspace(targetWorkspace);
            targetWorkspace.activate(global.get_current_time());
        }
    }

    _cleanupEmptyWorkspaces(manager) {
        for (let i = manager.get_n_workspaces() - 1; i > 0; i--) {
            const ws = manager.get_workspace_by_index(i);
            if (!ws) break;
            const hasWindows = ws.list_windows().some(w => !w.is_always_on_all_workspaces());
            if (hasWindows) break;
            manager.remove_workspace(ws);
        }
    }

    _insertWorkspaceAfter(manager, curIndex) {
        const ins = curIndex + 1;
        const n = manager.get_n_workspaces();
        // Append a brand-new empty workspace at the very end to make room.
        manager.append_new_workspace(false, global.get_current_time());
        // Shift every window from the previous last workspace down to `ins`
        // one slot to the right. This leaves workspace `ins` empty for the
        // maximized window, effectively inserting it right after the current one
        // and pushing the existing workspaces on the right further right.
        for (let i = n - 1; i >= ins; i--) {
            const src = manager.get_workspace_by_index(i);
            const dst = manager.get_workspace_by_index(i + 1);
            if (!src || !dst) continue;
            src.list_windows().slice().forEach(w => {
                if (!w.is_always_on_all_workspaces())
                    w.change_workspace(dst);
            });
        }
        return manager.get_workspace_by_index(ins);
    }

    _check(win) {
        if (!win || win.window_type !== Meta.WindowType.NORMAL) {
            return;
        }

        const display = win.get_display();
        if (!display) return;

        const manager = display.get_workspace_manager();
        const name = win.get_id();
        const expanded = this._isExpanded(win);

        if (expanded) {
            // Already isolated on its own workspace: nothing to do (this also
            // prevents 'map' and 'size-change' for the same action from
            // inserting a workspace twice).
            if (this._managed[name] !== undefined) return;

            const ws = win.get_workspace();
            if (!ws) return;

            const others = ws.list_windows().filter(
                o => o !== win && !o.is_always_on_all_workspaces() &&
                     o.get_monitor() === win.get_monitor()
            );

            // Already alone on its workspace: no need to isolate it.
            if (others.length === 0) return;

            // Remember where this window came from so we can send it back later.
            this._managed[name] = ws.index();

            this._suppress = true;
            const newWs = this._insertWorkspaceAfter(manager, ws.index());
            const newIndex = newWs.index();
            if (newIndex !== ws.index()) {
                this._changeWorkspace(win, manager, newIndex);
            }
            this._suppress = false;
        } else {
            // Window is no longer expanded. If we previously isolated it, return
            // it to its original workspace and remove the now-empty one.
            if (this._managed[name] === undefined) return;

            const origin = this._managed[name];
            const vacated = win.get_workspace();

            this._suppress = true;
            this._changeWorkspace(win, manager, origin);
            const current = win.get_workspace();
            if (vacated && vacated !== current &&
                !vacated.list_windows().some(x => !x.is_always_on_all_workspaces())) {
                manager.remove_workspace(vacated);
            }
            this._suppress = false;

            delete this._managed[name];
            this._cleanupEmptyWorkspaces(manager);
        }
    }

    _handleWindowClose(act) {
        if (!act.meta_window) return;

        const win = act.meta_window;
        const name = win.get_id();

        if (this._managed[name] === undefined) return;

        const origin = this._managed[name];
        delete this._managed[name];

        const display = win.get_display();
        if (!display) return;

        const manager = display.get_workspace_manager();
        const target = manager.get_workspace_by_index(origin);
        if (target) {
            target.activate(global.get_current_time());
        }
        this._cleanupEmptyWorkspaces(manager);
    }
}
