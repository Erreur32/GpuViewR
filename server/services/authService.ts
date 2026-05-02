import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { UserRepository, type User } from '../database/models/User.js';

const SALT_ROUNDS = 10;
const TOKEN_TTL = '7d';

export interface JwtPayload {
  sub: number;
  username: string;
  role: 'admin' | 'user';
}

export const authService = {
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
  },

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  },

  signToken(user: User): string {
    const payload: JwtPayload = { sub: user.id, username: user.username, role: user.role };
    return jwt.sign(payload, config.jwtSecret, { expiresIn: TOKEN_TTL });
  },

  verifyToken(token: string): JwtPayload | null {
    try {
      return jwt.verify(token, config.jwtSecret) as JwtPayload;
    } catch {
      return null;
    }
  },

  async register(username: string, password: string): Promise<{ user: User; token: string }> {
    const trimmed = username.trim();
    if (trimmed.length < 3) throw new Error('Username must be at least 3 characters');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');

    if (UserRepository.findByUsername(trimmed)) {
      throw new Error('Username already taken');
    }
    // First user becomes admin automatically
    const role: 'admin' | 'user' = UserRepository.count() === 0 ? 'admin' : 'user';
    const passwordHash = await this.hashPassword(password);
    const user = UserRepository.create(trimmed, passwordHash, role);
    return { user, token: this.signToken(user) };
  },

  async login(username: string, password: string): Promise<{ user: User; token: string }> {
    const user = UserRepository.findByUsername(username.trim());
    if (!user) throw new Error('Invalid credentials');
    const ok = await this.verifyPassword(password, user.password_hash);
    if (!ok) throw new Error('Invalid credentials');
    return { user, token: this.signToken(user) };
  },
};
