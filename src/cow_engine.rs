use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CowMethod {
    Reflink,
    Clonefile,
    Hardlink,
    Copy,
}

impl CowMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            CowMethod::Reflink => "reflink",
            CowMethod::Clonefile => "clonefile",
            CowMethod::Hardlink => "hardlink",
            CowMethod::Copy => "copy",
        }
    }
}

pub struct CowCloneResult {
    pub method: CowMethod,
    pub elapsed_ms: f64,
}

fn try_reflink_cp(src: &Path, dest: &Path) -> bool {
    if cfg!(target_os = "macos") {
        return Command::new("cp")
            .args(["-c", "-R"])
            .arg(src)
            .arg(dest)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    if cfg!(target_os = "linux") {
        return Command::new("cp")
            .args(["--reflink=auto", "-R"])
            .arg(src)
            .arg(dest)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    false
}

pub fn hardlink_tree(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let s = entry.path();
        let d = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            hardlink_tree(&s, &d)?;
        } else if entry.file_type()?.is_file() {
            if fs::hard_link(&s, &d).is_err() {
                fs::copy(&s, &d)?;
            }
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let s = entry.path();
        let d = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else {
            fs::copy(&s, &d)?;
        }
    }
    Ok(())
}

pub fn cow_copy_path(src: &Path, dest: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if cfg!(target_os = "windows") {
        if dest.exists() {
            fs::remove_dir_all(dest).map_err(|e| e.to_string())?;
        }
        let status = Command::new("xcopy")
            .args([
                src.to_str().unwrap_or(""),
                dest.to_str().unwrap_or(""),
                "/E",
                "/I",
                "/H",
                "/Y",
                "/Q",
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
        copy_dir_recursive(src, dest).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if try_reflink_cp(src, dest) {
        return Ok(());
    }
    if hardlink_tree(src, dest).is_ok() {
        return Ok(());
    }
    copy_dir_recursive(src, dest).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn cow_clone_dir(src: &Path, dest: &Path, dry_run: bool) -> Result<CowCloneResult, String> {
    let start = Instant::now();
    if dry_run {
        return Ok(CowCloneResult {
            method: CowMethod::Copy,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
    }
    if dest.exists() {
        return Err(format!("Destination already exists: {}", dest.display()));
    }
    if cfg!(target_os = "windows") {
        cow_copy_path(src, dest)?;
        return Ok(CowCloneResult {
            method: CowMethod::Copy,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
    }
    if try_reflink_cp(src, dest) {
        let method = if cfg!(target_os = "macos") {
            CowMethod::Clonefile
        } else {
            CowMethod::Reflink
        };
        return Ok(CowCloneResult {
            method,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
    }
    if hardlink_tree(src, dest).is_ok() {
        return Ok(CowCloneResult {
            method: CowMethod::Hardlink,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
    }
    copy_dir_recursive(src, dest).map_err(|e| e.to_string())?;
    Ok(CowCloneResult {
        method: CowMethod::Copy,
        elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{}-{}", prefix, nanos))
    }

    #[test]
    fn cow_clone_small_tree() {
        let dir = temp_dir("wtb-cow");
        let src = dir.join("tiny");
        fs::create_dir_all(&src).unwrap();
        let mut f = fs::File::create(src.join("data.txt")).unwrap();
        f.write_all(b"x\n").unwrap();
        let dest = dir.join("tiny-clone");
        let res = cow_clone_dir(&src, &dest, false).unwrap();
        assert!(dest.join("data.txt").exists());
        assert!(res.elapsed_ms < 5000.0);
        let _ = fs::remove_dir_all(&dir);
    }
}
