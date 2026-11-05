#!/usr/bin/env node
/**
 * Ensure an admin account exists.
 *  - If ADMIN_USERNAME + ADMIN_PASSWORD (or legacy ADMIN_USER / ADMIN_PASS) are set,
 *    the admin is created with that password only when it does not exist yet (seed).
 *    Afterwards the password changed in the app is kept. Set ADMIN_PASSWORD_FORCE_RESET=true
 *    to force the env password once (e.g. forgotten password); remove it afterwards.
 *    No credentials file is written in this mode (recommended for cloud deploys).
 *  - Otherwise, on first boot a random password is generated and written to
 *    ADMIN_CREDENTIALS.txt (local use).
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { hashPassword, verifyPassword, generatePassword, findUserByUsername } = require('../auth');

const outFile = path.join(__dirname, '..', 'ADMIN_CREDENTIALS.txt');

async function ensureAdmin() {
  const envUser = process.env.ADMIN_USERNAME || process.env.ADMIN_USER;
  const envPass = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS;

  if (envUser && envPass) {
    const u = await findUserByUsername(envUser);
    if (u) {
      if (u.role !== 'admin') throw new Error(`用户名 ${envUser} 已被成员占用`);
      if (process.env.ADMIN_PASSWORD_FORCE_RESET === 'true' && (u.totp_enabled || !verifyPassword(envPass, u.password_hash))) {
        // recovery path: reset password AND clear 2FA (lost phone), kill all admin sessions
        await db.run(
          'UPDATE users SET password_hash = ?, disabled = 0, totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?',
          hashPassword(envPass), u.id
        );
        await db.run('DELETE FROM user_sessions WHERE user_id = ?', u.id);
        console.log(`管理员 ${envUser} 密码已按 ADMIN_PASSWORD_FORCE_RESET 重置并清除两步验证（请随后删除该变量）`);
      }
      return { created: false, username: envUser };
    }
    await db.run(
      `INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, 'admin', ?)`,
      envUser, hashPassword(envPass), '管理员'
    );
    console.log(`管理员已按环境变量创建: ${envUser}`);
    return { created: true, username: envUser };
  }

  const existing = await db.get("SELECT id, username FROM users WHERE role = 'admin' LIMIT 1");
  if (existing) return { created: false, username: existing.username };

  const username = 'admin';
  const password = generatePassword(18);
  if (await findUserByUsername(username)) throw new Error(`用户名 ${username} 已被占用`);
  const info = await db.run(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, 'admin', ?)`,
    username, hashPassword(password), '管理员'
  );
  const content = [
    '========================================',
    '  卡牌等级系统 - 管理员账号（请妥善保管）',
    '========================================',
    `用户名: ${username}`,
    `密码:   ${password}`,
    `用户ID: ${info.lastInsertRowid}`,
    `创建时间: ${new Date().toISOString()}`,
    '',
    '登录后请妥善保管此文件，勿提交到公开仓库。',
    '========================================',
    '',
  ].join('\n');
  fs.writeFileSync(outFile, content, { mode: 0o600 });
  console.log(`管理员已创建: ${username}，凭证已写入: ${outFile}`);
  return { created: true, username };
}

module.exports = { ensureAdmin, outFile };

if (require.main === module) {
  db.init()
    .then(ensureAdmin)
    .then((r) => { if (!r.created) console.log('管理员账号已存在。'); process.exit(0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
