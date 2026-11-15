// Express error middleware: client errors keep their message, code and details; unexpected errors are logged and hidden.
export function errorHandler(err, req, res, next) {
  if (!err.status || err.status >= 500) console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: status >= 500 && !err.status ? 'Something went wrong.' : err.message,
    code: err.code,
    details: err.status && err.status < 500 ? err.details : undefined,
  });
}
