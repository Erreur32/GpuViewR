#!/usr/bin/env tsx
/**
 * Admin CLI: reset a GpuViewR user's password.
 *
 * Why a CLI: if the only admin loses access to the web UI, there is no
 * in-app self-service flow (no email reset, by design — this is a
 * single-host LAN tool). This script is the official escape hatch.
 *
 *   tsx scripts/reset-password.ts --list
 *   tsx scripts/reset-password.ts <username>                 # prompts for new password
 *   tsx scripts/reset-password.ts <username> --password=...  # non-interactive
 *
 * Honors DATA_DIR from .env so it operates on the same SQLite file the
 * server uses (production or dev). Run it on the host that has the DB.
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { initializeDatabase, closeDatabase } from '../server/database/connection.js';
import { UserRepository } from '../server/database/models/User.js';
import { authService } from '../server/services/authService.js';

interface Args {
  list: boolean;
  username: string | null;
  password: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { list: false, username: null, password: null, help: false };
  for (const a of argv) {
    if (a === '--list' || a === '-l') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--password=')) out.password = a.slice('--password='.length);
    else if (!a.startsWith('-') && out.username === null) out.username = a;
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`GpuViewR — reset a user's password.

Usage:
  tsx scripts/reset-password.ts --list
  tsx scripts/reset-password.ts <username>
  tsx scripts/reset-password.ts <username> --password=<new-password>

Options:
  -l, --list                List all users (id, username, role).
      --password=<value>    Provide the new password non-interactively
                            (visible in shell history — prefer the prompt).
  -h, --help                Show this help.
`);
}

// Read a password from stdin without echoing it. The trick: wrap stdout in a
// Writable that drops chunks while we are inside readline.question, so each
// keystroke is still consumed by readline but never displayed.
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const mutableStdout = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true,
    });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  initializeDatabase();
  try {
    if (args.list) {
      const users = UserRepository.findAll();
      if (users.length === 0) {
        process.stdout.write('(no users yet — register the first one through the web UI)\n');
        return;
      }
      process.stdout.write('id\trole\tusername\n');
      for (const u of users) {
        process.stdout.write(`${u.id}\t${u.role}\t${u.username}\n`);
      }
      return;
    }

    if (!args.username) {
      process.stderr.write('error: missing <username>. Run with --help for usage.\n');
      process.exitCode = 2;
      return;
    }

    const user = UserRepository.findByUsername(args.username.trim());
    if (!user) {
      process.stderr.write(`error: no user named "${args.username}". Use --list to see existing users.\n`);
      process.exitCode = 1;
      return;
    }

    let newPassword = args.password;
    if (!newPassword) {
      if (!process.stdin.isTTY) {
        process.stderr.write('error: no TTY available for prompt. Pass --password=<value> instead.\n');
        process.exitCode = 2;
        return;
      }
      const first = await promptHidden(`New password for "${user.username}": `);
      const second = await promptHidden('Confirm: ');
      if (first !== second) {
        process.stderr.write('error: passwords do not match.\n');
        process.exitCode = 1;
        return;
      }
      newPassword = first;
    }

    if (newPassword.length < 8) {
      process.stderr.write('error: password must be at least 8 characters.\n');
      process.exitCode = 1;
      return;
    }

    const hash = await authService.hashPassword(newPassword);
    UserRepository.updatePassword(user.id, hash);
    process.stdout.write(`ok: password updated for "${user.username}" (id ${user.id}, role ${user.role}).\n`);
  } finally {
    closeDatabase();
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
