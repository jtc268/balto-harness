use serde::{Deserialize, Serialize};
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State};

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default)]
struct AppState {
    status_refreshed: AtomicBool,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BaltoStatus {
    phase: String,
    message: String,
    progress: u8,
    gpu_name: Option<String>,
    gpu_memory_mib: Option<u64>,
    gpu_memory_used_mib: Option<u64>,
    docker_installed: bool,
    docker_ready: bool,
    tailscale_installed: bool,
    tailscale_signed_in: bool,
    tailscale_dns_name: Option<String>,
    remote_enabled: bool,
    remote_url: Option<String>,
    inference_ready: bool,
    workspace_ready: bool,
    warning: Option<String>,
    updated_at: Option<String>,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| format!("Cannot resolve Balto data directory: {error}"))
}

fn resource_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|path| path.join("runtime"))
        .map_err(|error| format!("Cannot resolve Balto runtime resources: {error}"))
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("state.json"))
}

fn powershell_command(script: &Path, action: &str, app_data: &Path, resources: &Path) -> Command {
    let app_exe = std::env::current_exe().unwrap_or_default();
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg("-Action")
        .arg(action)
        .arg("-BaltoData")
        .arg(app_data)
        .arg("-Resources")
        .arg(resources)
        .arg("-AppExe")
        .arg(app_exe)
        .creation_flags(CREATE_NO_WINDOW);
    command
}

fn read_status(app: &AppHandle) -> Result<BaltoStatus, String> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(BaltoStatus {
            phase: "not-installed".into(),
            message: "Run the system check to begin.".into(),
            ..Default::default()
        });
    }
    let body = fs::read_to_string(&path)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    serde_json::from_str(&body).map_err(|error| format!("Invalid Balto state: {error}"))
}

#[tauri::command]
fn get_status(app: AppHandle, app_state: State<'_, AppState>) -> Result<BaltoStatus, String> {
    let app_data = app_data_dir(&app)?;
    fs::create_dir_all(&app_data)
        .map_err(|error| format!("Cannot create {}: {error}", app_data.display()))?;

    if !app_state.status_refreshed.swap(true, Ordering::Relaxed) {
        let resources = resource_runtime_dir(&app)?;
        let script = resources.join("balto.ps1");
        if script.exists() {
            let _ = powershell_command(&script, "status", &app_data, &resources)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    read_status(&app)
}

fn spawn_action(app: &AppHandle, action: &str) -> Result<(), String> {
    let app_data = app_data_dir(app)?;
    fs::create_dir_all(&app_data)
        .map_err(|error| format!("Cannot create {}: {error}", app_data.display()))?;
    let resources = resource_runtime_dir(app)?;
    let script = resources.join("balto.ps1");
    if !script.exists() {
        return Err(format!("Missing packaged runtime: {}", script.display()));
    }
    powershell_command(&script, action, &app_data, &resources)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not start Balto action '{action}': {error}"))
}

#[tauri::command]
fn setup_stack(app: AppHandle) -> Result<(), String> {
    spawn_action(&app, "setup")
}

#[tauri::command]
fn start_stack(app: AppHandle) -> Result<(), String> {
    spawn_action(&app, "start")
}

#[tauri::command]
fn stop_stack(app: AppHandle) -> Result<(), String> {
    spawn_action(&app, "stop")
}

#[tauri::command]
fn enable_remote(app: AppHandle) -> Result<(), String> {
    spawn_action(&app, "remote-on")
}

#[tauri::command]
fn disable_remote(app: AppHandle) -> Result<(), String> {
    spawn_action(&app, "remote-off")
}

#[tauri::command]
fn open_workspace(app: AppHandle) -> Result<(), String> {
    if !read_status(&app)?.workspace_ready {
        return Err("Balto is still starting.".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Balto window is unavailable.".to_string())?;
    window
        .navigate(
            "http://127.0.0.1:3080"
                .parse()
                .map_err(|_| "Invalid workspace URL")?,
        )
        .map_err(|error| format!("Could not open the Balto workspace: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_status,
            setup_stack,
            start_stack,
            stop_stack,
            enable_remote,
            disable_remote,
            open_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running Balto Harness");
}
