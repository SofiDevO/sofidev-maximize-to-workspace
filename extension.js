import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';

export default class MaximizeWorkspaceHistory extends Extension {
    constructor(args) {
        super(args);
        this._oldWorkspaces = {};
        this._fullScreenApps = {};
        this._timeoutIds = []; // Track timeouts to prevent ghost processes
        this._suppress = false; // Guard against re-entrancy from our own workspace moves
    }

    // GNOME 49 compatibility helper
    _isWindowMaximized(win) {
        // GNOME 49 completely removed get_maximized() in favor of is_maximized()
        if (typeof win.is_maximized === 'function') {
            return win.is_maximized();
        }
        // Fallback for GNOME 48 and older
        if (typeof win.get_maximized === 'function') {
            return win.get_maximized() === Meta.MaximizeFlags.BOTH;
        }
        return false;
    }

    enable() {
        // Bind all window manager signals directly to this extension object
        global.window_manager.connectObject(
            'map', (_, act, change) => {
                if (this._suppress) return;
                if (act.meta_window && this._isWindowMaximized(act.meta_window)) {
                    this._check(act.meta_window, change);
                }
            },
            'size-change', (_, act, change) => {
                if (this._suppress) return;
                let timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, 300, () => {
                    if (act.meta_window) {
                        this._check(act.meta_window, change);
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
        this._oldWorkspaces = {};
        this._fullScreenApps = {};
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

    _check(win, change) {
        if (!win || win.window_type !== Meta.WindowType.NORMAL) {
            return;
        }
        
        const display = win.get_display();
        if (!display) return;
        
        const workspacemanager = display.get_workspace_manager();
        const name = win.get_id();
        const currentWorkspace = win.get_workspace();
        
        if (!currentWorkspace) return;

        const w = currentWorkspace.list_windows()
            .filter(w => w !== win && !w.is_always_on_all_workspaces() && win.get_monitor() === w.get_monitor());

        if (change === Meta.SizeChange.UNFULLSCREEN || change === Meta.SizeChange.UNMAXIMIZE || (change === Meta.SizeChange.MAXIMIZE && !this._isWindowMaximized(win))) {
            
            if (this._fullScreenApps[name] !== undefined) {
                if (w.length === 0) {
                    this._suppress = true;
                    const vacated = win.get_workspace();
                    this._changeWorkspace(win, workspacemanager, this._fullScreenApps[name]);
                    if (vacated && !vacated.list_windows().some(x => !x.is_always_on_all_workspaces()))
                        workspacemanager.remove_workspace(vacated);
                    this._suppress = false;
                    this._cleanupEmptyWorkspaces(workspacemanager);
                }
                delete this._fullScreenApps[name];
                return;
            }
            
            if (this._oldWorkspaces[name] !== undefined) {
                if (w.length === 0) {
                    this._suppress = true;
                    const vacated = win.get_workspace();
                    this._changeWorkspace(win, workspacemanager, this._oldWorkspaces[name]);
                    if (vacated && !vacated.list_windows().some(x => !x.is_always_on_all_workspaces()))
                        workspacemanager.remove_workspace(vacated);
                    this._suppress = false;
                    this._cleanupEmptyWorkspaces(workspacemanager);
                }
                delete this._oldWorkspaces[name];
            }
            return;
        }

        // If this window's maximize/fullscreen was already handled (e.g. both
        // 'map' and 'size-change' fired for the same action), don't insert again.
        if (this._oldWorkspaces[name] !== undefined || this._fullScreenApps[name] !== undefined) {
            return;
        }

        if (change === Meta.SizeChange.FULLSCREEN) {
            this._fullScreenApps[name] = currentWorkspace.index();
        } else {
            this._oldWorkspaces[name] = currentWorkspace.index();
        }

        if (w.length >= 1) {
            this._suppress = true;
            const newWs = this._insertWorkspaceAfter(workspacemanager, currentWorkspace.index());
            this._suppress = false;
            const newIndex = newWs.index();
            if (newIndex === currentWorkspace.index()) return;
            this._changeWorkspace(win, workspacemanager, newIndex);
        }
    }

    _handleWindowClose(act) {
        if (!act.meta_window) return;
        
        let win = act.meta_window;
        let name = win.get_id();
        const vacated = win.get_workspace();
        
        if (this._oldWorkspaces[name] !== undefined) {
            const display = win.get_display();
            if (display) {
                const wm = display.get_workspace_manager();
                const targetWorkspace = wm.get_workspace_by_index(this._oldWorkspaces[name]);
                if (targetWorkspace) {
                    targetWorkspace.activate(global.get_current_time());
                }
                if (vacated && !vacated.list_windows().some(x => !x.is_always_on_all_workspaces())) {
                    this._suppress = true;
                    wm.remove_workspace(vacated);
                    this._suppress = false;
                }
                this._cleanupEmptyWorkspaces(wm);
            }
            delete this._oldWorkspaces[name];
        }
        
        if (this._fullScreenApps[name] !== undefined) {
            delete this._fullScreenApps[name];
        }
    }
}
