use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use tauri::Emitter;
use serde::Serialize;
use futures_util::StreamExt;

struct AppState {
    file_path: Mutex<Option<String>>,
}

fn config_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("budget-app")
}

fn config_file() -> PathBuf {
    config_dir().join("config.json")
}

fn read_config() -> Option<String> {
    let path = config_file();
    let content = fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    parsed.get("last_file")?.as_str().map(String::from)
}

fn write_config(file_path: &str) {
    let dir = config_dir();
    fs::create_dir_all(&dir).ok();
    let config = serde_json::json!({ "last_file": file_path });
    fs::write(config_file(), serde_json::to_string_pretty(&config).unwrap()).ok();
}

#[tauri::command]
fn get_last_file_path(state: State<'_, AppState>) -> Option<String> {
    let guard = state.file_path.lock().unwrap();
    guard.clone()
}

#[tauri::command]
fn set_file_path(path: String, state: State<'_, AppState>) {
    write_config(&path);
    let mut guard = state.file_path.lock().unwrap();
    *guard = Some(path);
}

#[tauri::command]
fn load_data(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_data(path: String, data: String) -> Result<(), String> {
    fs::write(&path, &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[derive(Serialize)]
struct FileInfo {
    path: String,
    modified_secs: u64,
}

#[tauri::command]
fn list_dir_files(dir: String, ext: String) -> Vec<FileInfo> {
    let dir_path = std::path::Path::new(&dir);
    let mut results = Vec::new();
    let Ok(entries) = fs::read_dir(dir_path) else { return results; };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if !ext.is_empty() && !name.ends_with(&ext) { continue; }
        let modified_secs = entry.metadata()
            .and_then(|m| m.modified())
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
            .unwrap_or(0);
        results.push(FileInfo { path: path.to_string_lossy().to_string(), modified_secs });
    }
    results
}

#[derive(Serialize)]
struct DdgResult {
    title: String,
    snippet: String,
}

fn strip_html(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => { in_tag = false; out.push(' '); }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
       .replace("&lt;", "<")
       .replace("&gt;", ">")
       .replace("&quot;", "\"")
       .replace("&#39;", "'")
       .replace("&nbsp;", " ")
       .split_whitespace()
       .collect::<Vec<_>>()
       .join(" ")
}

fn parse_ddg_html(html: &str) -> Vec<DdgResult> {
    let mut results = Vec::new();
    for chunk in html.split("result__body") {
        if results.len() >= 6 { break; }
        let title = match chunk.find("result__a") {
            Some(i) => match chunk[i..].find('>') {
                Some(j) => {
                    let after = &chunk[i + j + 1..];
                    match after.find("</a>") {
                        Some(k) => strip_html(&after[..k]),
                        None => continue,
                    }
                }
                None => continue,
            },
            None => continue,
        };
        let snippet = match chunk.find("result__snippet") {
            Some(i) => match chunk[i..].find('>') {
                Some(j) => {
                    let after = &chunk[i + j + 1..];
                    match after.find("</a>") {
                        Some(k) => strip_html(&after[..k]),
                        None => String::new(),
                    }
                }
                None => String::new(),
            },
            None => String::new(),
        };
        if !title.is_empty() {
            results.push(DdgResult { title, snippet });
        }
    }
    results
}

fn local_ollama_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".local").join("share").join("budget-app").join("ollama")
}

#[tauri::command]
fn find_ollama() -> Option<String> {
    // 1. Check local install (tarball extracts to bin/ollama)
    let base = local_ollama_path().parent().unwrap().to_path_buf();
    let bin_path = base.join("bin").join("ollama");
    if bin_path.exists() {
        return Some(bin_path.to_string_lossy().to_string());
    }
    let local = local_ollama_path();
    if local.exists() {
        return Some(local.to_string_lossy().to_string());
    }
    // 2. Check PATH
    let result = std::process::Command::new("which").arg("ollama").output();
    if let Ok(out) = result {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
}

#[derive(Serialize, Clone)]
struct OllamaInstallProgress {
    status: String,
    percent: u32,
}

#[tauri::command]
async fn install_ollama(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        return Err("Automatic install is only supported on Linux. On Windows, install Ollama from https://ollama.com then click Start Ollama.".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let url = if cfg!(target_arch = "aarch64") {
            "https://github.com/ollama/ollama/releases/latest/download/ollama-linux-arm64.tar.zst"
        } else {
            "https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64.tar.zst"
        };

        let _ = app.emit("ollama_progress", OllamaInstallProgress {
            status: "Connecting…".into(),
            percent: 0,
        });

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;

        let response = client.get(url)
            .send()
            .await
            .map_err(|e| format!("Download failed: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Download failed: HTTP {}", response.status()));
        }

        let total = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut bytes: Vec<u8> = if total > 0 { Vec::with_capacity(total as usize) } else { Vec::new() };
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            bytes.extend_from_slice(&chunk);
            let pct = if total > 0 { (downloaded * 100 / total) as u32 } else { 0 };
            let _ = app.emit("ollama_progress", OllamaInstallProgress {
                status: format!("Downloading… {:.1} MB", downloaded as f64 / 1_048_576.0),
                percent: pct,
            });
        }

        let _ = app.emit("ollama_progress", OllamaInstallProgress {
            status: "Extracting…".into(),
            percent: 99,
        });

        let archive_path = std::env::temp_dir().join("ollama-install.tar.zst");
        fs::write(&archive_path, &bytes).map_err(|e| e.to_string())?;

        let binary_dir = local_ollama_path().parent().unwrap().to_path_buf();
        fs::create_dir_all(&binary_dir).map_err(|e| e.to_string())?;

        let tar_out = std::process::Command::new("tar")
            .args(["--zstd", "-xf", archive_path.to_str().unwrap(), "-C", binary_dir.to_str().unwrap()])
            .output()
            .map_err(|e| format!("Extraction failed: {}", e))?;

        fs::remove_file(&archive_path).ok();

        if !tar_out.status.success() {
            return Err(format!("Extraction failed: {}", String::from_utf8_lossy(&tar_out.stderr)));
        }

        let binary_path = binary_dir.join("bin").join("ollama");
        if !binary_path.exists() {
            let alt = binary_dir.join("ollama");
            if !alt.exists() {
                return Err("Could not find ollama binary after extraction".to_string());
            }
            let dest = local_ollama_path();
            fs::rename(&alt, &dest).map_err(|e| e.to_string())?;
        }

        let final_path = if binary_path.exists() { binary_path } else { local_ollama_path() };

        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&final_path).map_err(|e| e.to_string())?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&final_path, perms).map_err(|e| e.to_string())?;
        }

        let _ = app.emit("ollama_progress", OllamaInstallProgress {
            status: "Install complete!".into(),
            percent: 100,
        });

        Ok(final_path.to_string_lossy().to_string())
    }
}

#[tauri::command]
fn save_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(&path, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_base64(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("base64 decode error: {}", e))?;
    fs::write(&path, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_home_dir() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn start_ollama(binary_path: String) -> Result<(), String> {
    std::process::Command::new(&binary_path)
        .arg("serve")
        .spawn()
        .map_err(|e| format!("Failed to start Ollama: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn search_ddg(query: String) -> Result<Vec<DdgResult>, String> {
    let encoded: String = query.chars().map(|c| {
        if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' { c.to_string() }
        else if c == ' ' { "+".to_string() }
        else { format!("%{:02X}", c as u32) }
    }).collect();
    let url = format!("https://html.duckduckgo.com/html/?q={}", encoded);
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let html = client.get(&url)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_ddg_html(&html))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let last_path = read_config();

    tauri::Builder::default()
        .manage(AppState {
            file_path: Mutex::new(last_path),
        })
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_last_file_path,
            set_file_path,
            load_data,
            save_data,
            file_exists,
            list_dir_files,
            search_ddg,
            find_ollama,
            install_ollama,
            start_ollama,
            save_bytes,
            save_base64,
            get_home_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
