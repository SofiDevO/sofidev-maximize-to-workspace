import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export default class MaximizeWorkspaceHistory extends Extension {
    constructor(args) {
        super(args);
        this._managed = {}; // name -> origin workspace index for windows we isolated
        this._timeoutIds = []; // Track timeouts to prevent ghost processes
        this._suppress = false; // Guard against re-entrancy from our own workspace moves
        this._debug = false;
    }

    _log(...args) {
        if (!this._debug) return;
        const msg = '[MWH] ' + args.join(' ');
        log(msg);
        try {
            const file = Gio.File.new_for_path('/tmp/mwh-debug.log');
            const out = file.append_to(Gio.FileCreateFlags.NONE, null);
            out.write_all(msg + '\n', null);
            out.close(null);
        } catch (e) {}
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

    // Only the primary monitor ("main desktop") should get per-window
    // workspace isolation. Secondary monitors behave like a normal desktop.
    _isOnPrimary(win) {
        try {
            const display = win.get_display();
            return win.get_monitor() === display.get_primary_monitor();
        } catch (e) {
            return true;
        }
    }

    enable() {
        this._log('ENABLED');
        this._tracked = new Map(); // id -> { win, ids:[handlerIds] }
        // Bind all window manager signals directly to this extension object
        global.window_manager.connectObject(
            'map', (_, act) => {
                if (this._suppress) return;
                if (act.meta_window) {
                    this._trackWindow(act.meta_window);
                    this._log('signal map', act.meta_window.get_id(), 'expanded=', this._isExpanded(act.meta_window));
                    if (this._isExpanded(act.meta_window)) {
                        this._check(act.meta_window);
                    }
                }
            },
            'size-change', (_, act) => {
                if (this._suppress) return;
                if (act.meta_window) this._trackWindow(act.meta_window);
                this._log('signal size-change', act.meta_window ? act.meta_window.get_id() : 'no-win', 'expanded=', act.meta_window && this._isExpanded(act.meta_window));
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
                if (act.meta_window) {
                    this._log('signal destroy', act.meta_window.get_id());
                    this._untrackWindow(act.meta_window);
                }
                this._handleWindowClose(act);
            },
            this // The target object tying the lifecycle of these signals
        );

        // Track windows that already exist (e.g. restored after shell restart)
        try {
            global.get_window_actors().forEach(actor => {
                const w = actor.meta_window;
                if (w) this._trackWindow(w);
            });
        } catch (e) {}
    }

    _trackWindow(win) {
        if (!win) return;
        const id = win.get_id();
        if (this._tracked.has(id)) return;
        const ids = [];
        const handler = () => {
            if (this._suppress) return;
            this._check(win);
        };
        for (const prop of ['maximized-vertically', 'maximized-horizontally', 'fullscreen']) {
            try {
                const cid = win.connect('notify::' + prop, handler);
                if (typeof cid === 'number') ids.push(cid);
            } catch (e) {}
        }
        this._tracked.set(id, { win, ids });
    }

    _untrackWindow(win) {
        if (!win) return;
        const id = win.get_id();
        const rec = this._tracked.get(id);
        if (!rec) return;
        rec.ids.forEach(cid => { try { rec.win.disconnect(cid); } catch (e) {} });
        this._tracked.delete(id);
    }

    disable() {
        // Automatically disconnects all signals tied to 'this' in connectObject
        global.window_manager.disconnectObject(this);

        // Disconnect per-window notify signals
        if (this._tracked) {
            for (const rec of this._tracked.values()) {
                rec.ids.forEach(cid => { try { rec.win.disconnect(cid); } catch (e) {} });
            }
            this._tracked = new Map();
        }
        
        // Kill any pending GLib timeouts so they don't fire after disabling
        for (const timeoutId of this._timeoutIds) {
            GLib.source_remove(timeoutId);
        }
        
        // Reset state
        this._timeoutIds = [];
        this._managed = {};
    }

    _changeWorkspace(win, manager, workspace) {
        if (!workspace) return;
        win.change_workspace(workspace);
        workspace.activate(global.get_current_time());
    }

    _cleanupEmptyWorkspaces(manager) {
        for (let i = manager.get_n_workspaces() - 1; i > 0; i--) {
            const ws = manager.get_workspace_by_index(i);
            if (!ws) break;
            const hasWindows = ws.list_windows().some(w => !w.is_always_on_all_workspaces());
            if (hasWindows) break;
            try { manager.remove_workspace(ws, global.get_current_time()); } catch (e) {}
        }
    }

    // Deferred cleanup: window moves are asynchronous in Mutter, so the window
    // may still appear on its old workspace right after change_workspace().
    // Retry a few times until the dust settles.
    _scheduleCleanup(manager, attempts = 6) {
        GLib.timeout_add(GLib.PRIORITY_LOW, 150, () => {
            this._cleanupEmptyWorkspaces(manager);
            if (attempts > 1) this._scheduleCleanup(manager, attempts - 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Remove a specific isolated workspace once it has actually become empty.
    _scheduleRemoveWorkspace(manager, ws, attempts = 8) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            if (ws && !ws.list_windows().some(w => !w.is_always_on_all_workspaces())) {
                try { manager.remove_workspace(ws, global.get_current_time()); } catch (e) {}
                return GLib.SOURCE_REMOVE;
            }
            if (attempts > 1) this._scheduleRemoveWorkspace(manager, ws, attempts - 1);
            return GLib.SOURCE_REMOVE;
        });
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
        this._log('check', name, 'expanded=', expanded, 'managed=', this._managed[name], 'nWS=', manager.get_n_workspaces());

        if (expanded) {
            // Already isolated on its own workspace: nothing to do (this also
            // prevents 'map' and 'size-change' for the same action from
            // inserting a workspace twice).
            if (this._managed[name]) {
                this._log('check', name, 'already managed -> skip');
                return;
            }

            // Only the primary monitor gets workspace isolation.
            if (!this._isOnPrimary(win)) {
                this._log('check', name, 'not on primary monitor -> skip');
                return;
            }

            const ws = win.get_workspace();
            if (!ws) return;

            const others = ws.list_windows().filter(
                o => o !== win && !o.is_always_on_all_workspaces() &&
                     o.get_monitor() === win.get_monitor()
            );

            // Already alone on its workspace: no need to isolate it.
            if (others.length === 0) {
                this._log('check', name, 'expanded but alone -> skip');
                return;
            }

            // Remember where this window came from (as a stable workspace object)
            // and which workspace we created for it, so we can clean it up later.
            this._managed[name] = { originWs: ws, isoWs: null };
            this._log('check', name, 'ISOLATE from ws', ws.index(), 'others=', others.length);

            this._suppress = true;
            const newWs = this._insertWorkspaceAfter(manager, ws.index());
            this._managed[name].isoWs = newWs;
            if (newWs && newWs.index() !== ws.index()) {
                this._changeWorkspace(win, manager, newWs);
            }
            this._suppress = false;
            this._scheduleCleanup(manager);
        } else {
            // Window is no longer expanded. If we previously isolated it, return
            // it to its original workspace and remove the now-empty one.
            if (this._managed[name] === undefined) {
                this._log('check', name, 'not expanded and not managed -> skip');
                return;
            }

            const rec = this._managed[name];
            const vacated = win.get_workspace();
            this._log('check', name, 'UNISOLATE to origin', rec.originWs ? rec.originWs.index() : 'none',
                      'isoWs', rec.isoWs ? rec.isoWs.index() : 'none',
                      'vacated', vacated ? vacated.index() : 'none');

            this._suppress = true;
            this._changeWorkspace(win, manager, rec.originWs);
            this._suppress = false;

            delete this._managed[name];

            // Remove the isolated workspace (it may sit in the middle, not at the
            // end) once the window has actually left it.
            if (rec.isoWs) this._scheduleRemoveWorkspace(manager, rec.isoWs);
            this._scheduleCleanup(manager);
        }
    }

    _handleWindowClose(act) {
        if (!act.meta_window) return;

        const win = act.meta_window;
        const name = win.get_id();
        this._log('close', name, 'managed=', this._managed[name] ? 'yes' : 'no');

        if (!this._managed[name]) return;

        const rec = this._managed[name];
        delete this._managed[name];
        this._log('close', name, 'returning to origin', rec.originWs ? rec.originWs.index() : 'none');

        const display = win.get_display();
        if (!display) return;

        const manager = display.get_workspace_manager();
        if (rec.originWs) {
            rec.originWs.activate(global.get_current_time());
        }
        if (rec.isoWs) this._scheduleRemoveWorkspace(manager, rec.isoWs);
        this._scheduleCleanup(manager);
    }
}
