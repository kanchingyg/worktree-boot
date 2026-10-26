use std::collections::HashMap;

const PORT_KEYS: &[&str] = &["PORT", "VITE_PORT", "NEXT_PUBLIC_PORT", "DEV_SERVER_PORT"];

pub fn shift_port_number(port: u16, offset: u16) -> u16 {
    port + offset
}

pub fn shift_ports_in_text(text: &str, offset: u16) -> String {
    if offset == 0 {
        return text.to_string();
    }
    let out = shift_url_ports(text, offset);
    out.lines()
        .map(|line| shift_env_line(line, offset))
        .collect::<Vec<_>>()
        .join("\n")
}

fn shift_url_ports(text: &str, offset: u16) -> String {
    let hosts = [
        "http://127.0.0.1:",
        "http://localhost:",
        "https://127.0.0.1:",
        "https://localhost:",
    ];
    let mut out = text.to_string();
    for prefix in hosts {
        let mut search_from = 0;
        while let Some(rel) = out[search_from..].find(prefix) {
            let start = search_from + rel + prefix.len();
            let port_digits: String = out[start..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if port_digits.len() >= 2 && port_digits.len() <= 5 {
                if let Ok(port) = port_digits.parse::<u16>() {
                    let new_port = shift_port_number(port, offset).to_string();
                    out.replace_range(start..start + port_digits.len(), &new_port);
                    search_from = start + new_port.len();
                    continue;
                }
            }
            search_from = start;
        }
    }
    out
}

fn shift_env_line(line: &str, offset: u16) -> String {
    let Some((key, val)) = line.split_once('=') else {
        return line.to_string();
    };
    let val = val.trim();
    if PORT_KEYS.contains(&key) && val.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(port) = val.parse::<u16>() {
            return format!("{}={}", key, shift_port_number(port, offset));
        }
    }
    if key == "OLLAMA_HOST" {
        let stripped = val
            .trim_start_matches("http://")
            .trim_start_matches("https://");
        if let Some((host, port_str)) = stripped.rsplit_once(':') {
            if let Ok(port) = port_str.parse::<u16>() {
                let shifted = shift_port_number(port, offset);
                let prefix = if val.starts_with("https://") {
                    "https://"
                } else if val.starts_with("http://") {
                    "http://"
                } else {
                    ""
                };
                return format!("{}={}{}:{}", key, prefix, host, shifted);
            }
        }
    }
    line.to_string()
}

pub fn build_local_llm_env(offset: u16) -> HashMap<String, String> {
    let ollama = std::env::var("OLLAMA_HOST").unwrap_or_else(|_| "127.0.0.1:11434".into());
    let local_url =
        std::env::var("LOCAL_LLM_URL").unwrap_or_else(|_| "http://127.0.0.1:11434/v1".into());
    let ollama_shifted = shift_ports_in_text(&format!("OLLAMA_HOST={}", ollama), offset);
    let ollama_val = ollama_shifted.split('=').nth(1).unwrap_or(&ollama).to_string();
    let local_shifted = shift_ports_in_text(&format!("X={}", local_url), offset);
    let local_val = local_shifted.strip_prefix("X=").unwrap_or(&local_url).to_string();
    HashMap::from([
        ("OLLAMA_HOST".into(), ollama_val),
        ("LOCAL_LLM_URL".into(), local_val),
    ])
}

pub fn merge_env_lines(existing: &str, extra: &HashMap<String, String>) -> String {
    let mut map: HashMap<String, String> = HashMap::new();
    for line in existing.lines() {
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.to_string(), v.to_string());
        }
    }
    for (k, v) in extra {
        map.insert(k.clone(), v.clone());
    }
    let mut lines: Vec<_> = map.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
    lines.sort();
    format!("{}\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shifts_vite_and_ollama_ports() {
        let text = "PORT=3000\nVITE_PORT=5173\nOLLAMA_HOST=127.0.0.1:11434\n";
        let out = shift_ports_in_text(text, 1);
        assert!(out.contains("PORT=3001"));
        assert!(out.contains("VITE_PORT=5174"));
        assert!(out.contains("11435"));
        let llm = build_local_llm_env(2);
        assert!(llm["LOCAL_LLM_URL"].contains("11436"));
    }
}
