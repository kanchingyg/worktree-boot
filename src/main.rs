use std::env;
use std::path::PathBuf;

use worktree_boot::mcp::{run_mcp_server, set_guards};
use worktree_boot::worktree::{
    boot_worktree, git_root, list_worktrees, teardown_worktree, BootOpts, TeardownOpts,
};
use worktree_boot::VERSION;

struct ParsedArgs {
    flags: Vec<String>,
    rest: Vec<String>,
}

fn parse_argv(argv: &[String]) -> ParsedArgs {
    let mut flags = Vec::new();
    let mut rest = Vec::new();
    for a in argv {
        if a.starts_with("--") {
            flags.push(a.clone());
        } else {
            rest.push(a.clone());
        }
    }
    ParsedArgs { flags, rest }
}

fn has_flag(flags: &[String], name: &str) -> bool {
    flags.iter().any(|f| f == name)
}

fn require_write_or_dry_run(allow_write: bool, dry_run: bool, action: &str) -> Option<i32> {
    if !allow_write && !dry_run {
        eprintln!("Pass --allow-write or --dry-run to {}.", action);
        return Some(1);
    }
    None
}

fn main() {
    let argv: Vec<String> = env::args().skip(1).collect();
    let parsed = parse_argv(&argv);
    let dry_run = has_flag(&parsed.flags, "--dry-run");
    let allow_write = has_flag(&parsed.flags, "--allow-write");
    let propagate_api_keys = has_flag(&parsed.flags, "--propagate-api-keys");
    set_guards(allow_write, dry_run);

    if has_flag(&parsed.flags, "--mcp") {
        if let Err(e) = run_mcp_server(VERSION) {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }

    let cmd = parsed.rest.first().map(|s| s.as_str());
    if cmd.is_none() || cmd == Some("-h") || cmd == Some("--help") {
        eprint!(
            "worktree-boot <branch> [--allow-write] [--dry-run] [--propagate-api-keys] | list | teardown <branch> | --mcp [--allow-write] [--dry-run]\n"
        );
        std::process::exit(2);
    }

    let code = match cmd.unwrap() {
        "list" => {
            let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            match git_root(&cwd).and_then(|root| list_worktrees(&root).map_err(|e| e)) {
                Ok(list) => {
                    println!("{}", serde_json::to_string_pretty(&list).unwrap());
                    0
                }
                Err(e) => {
                    eprintln!("{e}");
                    1
                }
            }
        }
        "teardown" => {
            let branch = parsed.rest.get(1);
            if branch.is_none() {
                2
            } else if let Some(1) = require_write_or_dry_run(allow_write, dry_run, "teardown") {
                1
            } else {
                match teardown_worktree(
                    branch.unwrap(),
                    &TeardownOpts {
                        repo_root: None,
                        confirm: true,
                        dry_run,
                    },
                ) {
                    Ok(removed) => {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(
                                &serde_json::json!({ "removed": removed }),
                            )
                            .unwrap()
                        );
                        0
                    }
                    Err(e) => {
                        eprintln!("{e}");
                        1
                    }
                }
            }
        }
        branch => {
            if let Some(1) = require_write_or_dry_run(allow_write, dry_run, "boot a worktree") {
                1
            } else {
                match boot_worktree(
                    branch,
                    &BootOpts {
                        repo_root: None,
                        port_offset: None,
                        dry_run,
                        propagate_api_keys,
                    },
                ) {
                    Ok(res) => {
                        println!("{}", serde_json::to_string_pretty(&res).unwrap());
                        0
                    }
                    Err(e) => {
                        eprintln!("{e}");
                        1
                    }
                }
            }
        }
    };
    std::process::exit(code);
}
