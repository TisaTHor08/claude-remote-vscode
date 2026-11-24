import * as crypto from 'crypto';

/** Clés dérivées du mot de passe. Le relais ne reçoit que `authKey` (dérivée à sens unique). */
export interface Keys { salt: string; encKey: Buffer; authKey: Buffer }
export interface StoredKeys { salt: string; encKey: string; authKey: string }

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function newSalt(): string { return crypto.randomBytes(16).toString('hex'); }

export function deriveKeys(password: string, saltHex: string): Promise<Keys> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), Buffer.from(saltHex, 'hex'), 32, SCRYPT, (err, master) => {
      if (err) return reject(err);
      const hk = (label: string) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), label, 32));
      resolve({ salt: saltHex, encKey: hk('claude-remote/enc/v1'), authKey: hk('claude-remote/auth/v1') });
    });
  });
}

export const serializeKeys = (k: Keys): StoredKeys => ({ salt: k.salt, encKey: k.encKey.toString('hex'), authKey: k.authKey.toString('hex') });
export const parseKeys = (s: StoredKeys): Keys => ({ salt: s.salt, encKey: Buffer.from(s.encKey, 'hex'), authKey: Buffer.from(s.authKey, 'hex') });

export function proof(authKey: Buffer, nonce: string): string {
  return crypto.createHmac('sha256', authKey).update(nonce).digest('hex');
}

/** 'q' = requête viewer→hôte, 'r' = réponse hôte→viewer, 'e' = évènement hôte→viewers. Lié à l'AAD pour interdire le rejeu croisé. */
export type Dir = 'q' | 'r' | 'e';

export function seal(key: Buffer, dir: Dir, obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(dir));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function open<T = any>(key: Buffer, dir: Dir, b64: string): T {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 29) throw new Error('payload trop court');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAAD(Buffer.from(dir));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

/** Identifiant de projet : slug lisible + 8 hex aléatoires (sert aussi d'« autorité » d'URI). */
export function newProjectId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'projet';
  return `${slug}-${crypto.randomBytes(4).toString('hex')}`;
}

export function passwordProblem(pw: string): string | undefined {
  if (pw.length < 12) return 'Au moins 12 caractères.';
  if (new Set(pw).size < 6) return 'Trop répétitif : varie les caractères.';
  return undefined;
}

export interface ProjectInfo { id: string; name: string; online: boolean; lastSeen: number }
