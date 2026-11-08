use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;
use tauri::Emitter;
use serde::Serialize;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};

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
    let content = serde_json::to_string_pretty(&config).unwrap();
    let target = config_file();
    let tmp = target.with_extension("tmp");
    if fs::write(&tmp, &content).is_ok() {
        fs::rename(&tmp, &target).ok();
    }
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

const ALLOWED_WRITE_EXTS: &[&str] = &["json", "budget", "xlsx", "csv", "md", "zip"];

/// Reject relative paths, `..` components and extensions the app never writes.
fn validate_write_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("Refusing to write to a relative path".to_string());
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("Refusing to write to a path containing '..'".to_string());
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !ALLOWED_WRITE_EXTS.contains(&ext.as_str()) {
        return Err(format!("Refusing to write a .{} file", ext));
    }
    Ok(())
}

fn mtime_ms(p: &Path) -> std::io::Result<u64> {
    let m = fs::metadata(p)?.modified()?;
    Ok(m.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("data");
    let tmp = path.with_file_name(format!(".{}.tmp", file_name));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?; // replaces existing on Unix and Windows
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

#[tauri::command]
async fn load_data(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fs::read_to_string(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Returns the new mtime (ms). If `expected_mtime` is given and the file on disk
/// has a different mtime, returns Err("CONFLICT") without writing.
#[tauri::command]
async fn save_data(path: String, data: String, expected_mtime: Option<u64>) -> Result<u64, String> {
    validate_write_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        if let Some(exp) = expected_mtime {
            if let Ok(cur) = mtime_ms(p) {
                if cur != exp {
                    return Err("CONFLICT".to_string());
                }
            }
        }
        atomic_write(p, data.as_bytes()).map_err(|e| e.to_string())?;
        mtime_ms(p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn file_mtime(path: String) -> Option<u64> {
    mtime_ms(Path::new(&path)).ok()
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

/// Decode named entities plus numeric (`&#39;`) and hex (`&#x27;`) entities.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        if let Some(end) = rest.find(';').filter(|e| *e <= 10) {
            let ent = &rest[1..end];
            let decoded = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                    u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32)
                }
                _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            };
            if let Some(c) = decoded {
                out.push(c);
                rest = &rest[end + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out
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
    decode_entities(&out)
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

/// Look up the SHA-256 for the downloaded asset in `sha256sum.txt` from the SAME release.
#[cfg(target_os = "linux")]
async fn fetch_expected_sha256(client: &reqwest::Client, asset_url: &reqwest::Url) -> Option<String> {
    let asset_name = asset_url.path_segments()?.last()?.to_string();
    let mut sums_url = asset_url.clone();
    sums_url.path_segments_mut().ok()?.pop().push("sha256sum.txt");
    let resp = client.get(sums_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    parse_sha256_line(&text, &asset_name)
}

/// Find the line for `asset_name` (names may carry a `./` or `*` prefix) and return its hash.
#[allow(dead_code)]
fn parse_sha256_line(text: &str, asset_name: &str) -> Option<String> {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.last().unwrap_or("");
        let name = name.trim_start_matches("./").trim_start_matches('*');
        if name == asset_name {
            return Some(hash.to_string());
        }
    }
    None
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

        let final_url = response.url().clone();
        let total = response.content_length().unwrap_or(0);
        let archive_path = std::env::temp_dir().join("ollama-install.tar.zst");

        // Stream to disk (not memory) while hashing.
        let mut file = fs::File::create(&archive_path).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut downloaded: u64 = 0;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            let pct = if total > 0 { (downloaded * 100 / total) as u32 } else { 0 };
            let _ = app.emit("ollama_progress", OllamaInstallProgress {
                status: format!("Downloading… {:.1} MB", downloaded as f64 / 1_048_576.0),
                percent: pct,
            });
        }
        file.sync_all().ok();
        drop(file);
        let actual_hash = format!("{:x}", hasher.finalize());

        let _ = app.emit("ollama_progress", OllamaInstallProgress {
            status: "Verifying download…".into(),
            percent: 98,
        });
        let verify_failed = "Couldn't verify the download. Install Ollama manually from ollama.com.".to_string();
        let expected = fetch_expected_sha256(&client, &final_url).await;
        match expected {
            Some(exp) if exp.eq_ignore_ascii_case(&actual_hash) => {}
            _ => {
                fs::remove_file(&archive_path).ok();
                return Err(verify_failed);
            }
        }

        let _ = app.emit("ollama_progress", OllamaInstallProgress {
            status: "Extracting…".into(),
            percent: 99,
        });

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
    validate_write_path(&path)?;
    atomic_write(Path::new(&path), &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_base64(path: String, data: String) -> Result<(), String> {
    validate_write_path(&path)?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("base64 decode error: {}", e))?;
    atomic_write(Path::new(&path), &bytes).map_err(|e| e.to_string())
}

/// Delete a backup file. Only files named like our backups may be deleted.
#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !(name.starts_with("kestl-backup-") || name.starts_with("qbdgt-backup-")) {
        return Err("Refusing to delete a file that is not a kestl backup".to_string());
    }
    fs::remove_file(p).map_err(|e| e.to_string())
}

#[tauri::command]
async fn backup_file(src: String, dir: String, stamp: String, max_count: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if stamp.is_empty() || !stamp.chars().all(|c| c.is_ascii_digit() || c == 'T' || c == '-') {
            return Err("Invalid backup stamp".to_string());
        }
        let src_path = Path::new(&src);
        let dir_path = Path::new(&dir);
        fs::create_dir_all(dir_path).map_err(|e| e.to_string())?;
        let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("json");
        let dest = dir_path.join(format!("kestl-backup-{}.{}", stamp, ext));
        // Copy the saved file as-is, so an encrypted data file yields an encrypted backup.
        fs::copy(src_path, &dest).map_err(|e| e.to_string())?;

        let mut backups: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
        if let Ok(entries) = fs::read_dir(dir_path) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("kestl-backup-") || name.starts_with("qbdgt-backup-") {
                    if let Ok(m) = entry.metadata().and_then(|m| m.modified()) {
                        backups.push((m, entry.path()));
                    }
                }
            }
        }
        backups.sort_by(|a, b| a.0.cmp(&b.0));
        let max = max_count.max(1) as usize;
        while backups.len() > max {
            let (_, p) = backups.remove(0);
            if p != dest {
                let _ = fs::remove_file(p);
            }
        }
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_home_dir() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn start_ollama() -> Result<(), String> {
    // The frontend can no longer choose which program to run: resolve the binary ourselves.
    let binary_path = find_ollama().ok_or_else(|| "Ollama is not installed".to_string())?;
    std::process::Command::new(&binary_path)
        .arg("serve")
        .spawn()
        .map_err(|e| format!("Failed to start Ollama: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn search_ddg(query: String) -> Result<Vec<DdgResult>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let html = client.get("https://html.duckduckgo.com/html/")
        .query(&[("q", &query)])
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
            file_mtime,
            backup_file,
            delete_file,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_entities("Tom &amp; Jerry&#39;s &#x27;x&#x2F;y&#x27; &lt;3 &unknown; &"), "Tom & Jerry's 'x/y' <3 &unknown; &");
    }

    #[test]
    fn finds_hash_with_prefix() {
        let t = "abc123  ./ollama-linux-amd64.tar.zst\ndef456  ollama-linux-arm64.tar.zst\n";
        assert_eq!(parse_sha256_line(t, "ollama-linux-amd64.tar.zst").as_deref(), Some("abc123"));
        assert_eq!(parse_sha256_line(t, "ollama-linux-arm64.tar.zst").as_deref(), Some("def456"));
        assert_eq!(parse_sha256_line(t, "nope"), None);
    }

    #[test]
    fn write_path_rules() {
        assert!(validate_write_path("relative/file.json").is_err());
        assert!(validate_write_path("/home/u/../etc/x.json").is_err());
        assert!(validate_write_path("/home/u/run.sh").is_err());
        assert!(validate_write_path("/home/u/data.json").is_ok());
        assert!(validate_write_path("/home/u/export.XLSX").is_ok());
    }
}
