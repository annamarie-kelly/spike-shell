// lib.rs — Tauri app assembly: plugins, managed state, the full command
// surface, and setup (CLI listener).
//
// OWNER: skeleton (shared). Module agents: you should NOT need to edit this
// file — every command is already registered. If you must add one, that's a
// contract change; flag it.

pub mod agent_broker;
pub mod attest;
pub mod auto_context;
pub mod cli_listener;
pub mod datatable;
pub mod fs_ops;
pub mod handoff;
pub mod html_preview;
pub mod live_webview;
pub mod pty;
pub mod shot;
pub mod state;
pub mod usage;
pub mod watcher;
pub mod workstore;
pub mod worktree;

use state::AppState;

// Keep the native macOS traffic lights centered in the transformed HTML
// titlebar. Native controls do not participate in the webview's CSS transform,
// so the frontend reports its current UI scale whenever zoom or window geometry
// changes. At 1x decorum's centered inset is y=16; the 38px titlebar's center
// moves by half of each added scaled pixel. decorum's inset parameter moves the
// visible button by y/2, so the command doubles that center delta.
#[tauri::command]
fn set_traffic_lights_zoom(app: tauri::AppHandle, factor: f32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        use tauri_plugin_decorum::WebviewWindowExt;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let y = (16.0 + 38.0 * (factor.clamp(0.5, 3.0) - 1.0)).max(0.0);
        // Remember the target y so the native resize handler can re-pin the dots
        // to the SAME place macOS keeps knocking them off of (see setup()).
        *app.state::<AppState>().traffic_light_y.lock().unwrap() = y;
        window
            .set_traffic_lights_inset(14.0, y)
            .map(|_| ())
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, factor);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // In-app updates. The frontend calls check()/downloadAndInstall() from
        // @tauri-apps/plugin-updater; process::relaunch restarts into the new
        // build. The manifest endpoint and the minisign pubkey that gates it
        // live in tauri.conf.json under plugins.updater.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        // CONTRACT CHANGE (skeleton): the HTML preview iframe loads its document
        // over this private scheme instead of `srcdoc`, so the previewed page
        // runs as its own document and escapes the app's inline-script CSP. See
        // html_preview.rs. Frontend registers content via `html_preview_register`
        // and points the iframe at the returned `spikehtml://` URL.
        .register_uri_scheme_protocol("spikehtml", |_ctx, request| {
            html_preview::handle(&request)
        })
        .invoke_handler(tauri::generate_handler![
            set_traffic_lights_zoom,
            // pty.rs
            pty::pty_spawn,
            pty::pty_handoff_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::sync_claude_theme,
            pty::mcp_list,
            pty::mcp_add,
            pty::mcp_remove,
            pty::mcp_login_spawn,
            // fs_ops.rs
            fs_ops::permission_rules,
            fs_ops::permission_rules_set,
            fs_ops::read_tree,
            fs_ops::get_last_root,
            fs_ops::set_last_root,
            fs_ops::read_file,
            fs_ops::save_file,
            fs_ops::rename_path,
            fs_ops::trash_path,
            fs_ops::move_path,
            fs_ops::copy_path,
            fs_ops::create_path,
            fs_ops::drop_image,
            fs_ops::ingest_path,
            fs_ops::clipboard_set_image,
            fs_ops::log_event,
            fs_ops::list_groups,
            fs_ops::save_group,
            fs_ops::delete_group,
            fs_ops::record_voice_edit,
            fs_ops::voice_dismiss,
            pty::analyze_voice,
            pty::title_workstream,
            pty::list_slash_commands,
            fs_ops::get_config,
            fs_ops::patch_config,
            fs_ops::pins_get,
            fs_ops::pins_set,
            fs_ops::agent_theme_command,
            fs_ops::open_log_dir,
            fs_ops::open_external,
            fs_ops::reveal_path,
            fs_ops::new_instance,
            fs_ops::share_file,
            fs_ops::fetch_url,
            fs_ops::path_stats,
            fs_ops::detect_engines,
            fs_ops::write_bundle,
            fs_ops::read_bundle,
            fs_ops::record_installed_template,
            fs_ops::read_group_steering,
            fs_ops::install_group,
            fs_ops::verify_bundle,
            fs_ops::install_bundle_extras,
            fs_ops::read_installed_templates,
            fs_ops::set_installed_templates,
            fs_ops::uninstall_bundle_extras,
            fs_ops::templates_dir,
            // html_preview.rs
            html_preview::html_preview_register,
            // usage.rs
            usage::usage_scan,
            usage::session_context,
            usage::transcript_tail,
            usage::agent_subagents,
            usage::agent_subagent_tail,
            usage::claude_account,
            usage::codex_usage_scan,
            usage::codex_account,
            // worktree.rs
            worktree::git_repo_check,
            worktree::worktree_resolve,
            // watcher.rs
            watcher::start_watch,
            // cli_listener.rs
            cli_listener::set_focus,
            // live_webview.rs — native child webview, the in-pane browser
            live_webview::live_webview_show,
            live_webview::live_webview_hide,
            live_webview::live_webview_close,
            live_webview::live_webview_back,
            live_webview::live_webview_forward,
            live_webview::live_webview_reload,
            live_webview::live_webview_devtools,
            live_webview::live_webview_url,
            live_webview::live_webview_set_expanded,
            live_webview::google_signin_show,
            live_webview::google_signin_close,
            // agent_broker.rs
            agent_broker::agent_recent,
            attest::attest_read_sources,
            attest::attest_turn,
            attest::attest_verdict,
            attest::playbook_turn,
            attest::playbook_run_check,
            // auto_context.rs
            auto_context::resolve_auto_context,
            // datatable.rs — SQLite-backed interactive tables (csv-mirrored)
            datatable::table_read,
            datatable::table_status,
            datatable::table_export_csv,
            datatable::table_import_csv,
            datatable::table_create,
            datatable::table_set_cell,
            datatable::table_add_row,
            datatable::table_delete_row,
            datatable::table_add_column,
            datatable::table_rename_column,
            datatable::table_retype_column,
            datatable::table_delete_column,
            datatable::table_duplicate_column,
            datatable::table_set_column_format,
            datatable::table_set_options,
            datatable::table_rename_option,
            datatable::table_reorder_columns,
            datatable::table_add_view,
            datatable::table_update_view,
            datatable::table_delete_view,
            datatable::table_set_meta,
            // workstore.rs — Company OS entities + the `@` mention index
            workstore::work_workspace_id,
            workstore::work_mention_lookup,
            workstore::work_entity_card,
            workstore::work_import_csv,
            workstore::work_entities,
            workstore::work_set_visibility,
        ])
        .setup(|app| {
            cli_listener::start(app.handle().clone());
            // Tauri's conf-level trafficLightPosition moves the buttons but not
            // their container view, which breaks hit-testing (visible but
            // unclickable). decorum resizes the container so clicks land.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                use tauri_plugin_decorum::WebviewWindowExt;
                let window = app.get_webview_window("main").unwrap();
                window.set_traffic_lights_inset(14.0, 16.0).unwrap();
                // Seed the shared inset at the 1x default; the frontend overwrites
                // it the moment it applies the saved zoom.
                *app.state::<AppState>().traffic_light_y.lock().unwrap() = 16.0;
                // macOS resets the traffic-light inset to its own default on EVERY
                // live resize, so the dots flick to the top of the bar and only
                // snap back once the frontend's async re-inset lands a frame later.
                // Re-apply synchronously here instead: this runs inside the native
                // resize event, so the dots never visibly leave center. We read the
                // frontend-owned y from shared state (NOT a hardcoded 16) — the old
                // reason this callback was avoided — so it stays correct at any zoom.
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Resized(_)) {
                        if let Some(win) = handle.get_webview_window("main") {
                            let y = *handle.state::<AppState>().traffic_light_y.lock().unwrap();
                            let _ = win.set_traffic_lights_inset(14.0, y);
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
