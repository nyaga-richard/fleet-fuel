// HTTP error helpers — consistent JSON error envelope across the API.
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const bad = (msg, details) => new ApiError(400, msg, details);
export const unauthorized = (msg = 'Authentication required') => new ApiError(401, msg);
export const forbidden = (msg = 'You do not have permission to perform this action') => new ApiError(403, msg);
export const notFound = (msg = 'Not found') => new ApiError(404, msg);
export const conflict = (msg) => new ApiError(409, msg);

// Wrap async route handlers so rejections reach the error middleware.
export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: `No such endpoint: ${req.method} ${req.originalUrl}` } });
}

// Postgres integrity/usage errors → honest 4xx with an actionable message,
// instead of a blank 500 (the DB error is still logged server-side). This
// covers the whole class of "the frontend sent an id/number the database
// rejects" failures — e.g. a fuel type deleted after the page was loaded.
const PG_FRIENDLY = {
  '23503': [400, 'That record is linked to something that no longer exists — it may have been deleted or the database was re-created. Reload the page and try again.'],
  '23514': [400, 'A value was rejected by a data rule. Check the numbers and selections and try again.'],
  '23505': [409, 'That record already exists.'],
  '22P02': [400, 'One of the provided identifiers is not valid.'],
  '22001': [400, 'A value is too long for one of the fields.'],
  '22003': [400, 'A numeric value is out of range.'],
  '08003': [503, 'The database connection was lost — try again shortly.'],
  '08006': [503, 'The database connection failed — try again shortly.'],
};

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = err.status || 500;
  let message = status >= 500 ? 'Internal server error' : err.message;

  const pg = PG_FRIENDLY[err.code];
  if (pg && status >= 500) {
    [status, message] = pg;
    // eslint-disable-next-line no-console
    console.error(`[api] ${req.method} ${req.originalUrl} → ${status} (pg ${err.code}):`, err.detail || err.message);
  } else if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(`[api] ${req.method} ${req.originalUrl} → 500:`, err.stack || err.message);
  }
  res.status(status).json({
    error: {
      message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}
