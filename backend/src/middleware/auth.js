// JWT authentication + role-based authorization middleware.
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { unauthorized, forbidden } from './errors.js';

export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  try {
    req.user = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    next();
  } catch (err) {
    next(unauthorized(err.name === 'TokenExpiredError' ? 'Session expired — sign in again' : 'Invalid token'));
  }
}

export const requireAuth = authenticate;

// requireRole('manager','admin') → only those roles pass.
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`Requires role: ${roles.join(' or ')} (you are ${req.user.role})`));
    }
    next();
  };
}

// requirePerm('reports:export') — permission-key gate (§26/§43). Resolves the
// key through the role→permission registry; never trusts a display name.
export function requirePerm(perm) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    import('../services/permissions.js').then(({ can }) => {
      if (!can(req.user.role, perm)) {
        return next(forbidden(`Requires permission: ${perm}`));
      }
      next();
    }).catch(next);
  };
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' },
  );
}
