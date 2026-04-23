class AppError extends Error {
  constructor(message, statusCode = 500, code = 'SERVER_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found', code = 'NOT_FOUND') {
    super(message, 404, code);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', code = 'VALIDATION_ERROR') {
    super(message, 400, code);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT') {
    super(message, 409, code);
  }
}

class ExternalServiceError extends AppError {
  constructor(message = 'External service error', code = 'EXTERNAL_SERVICE_ERROR') {
    super(message, 502, code);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', code = 'UNAUTHORIZED') {
    super(message, 401, code);
  }
}

module.exports = { AppError, NotFoundError, ValidationError, ConflictError, ExternalServiceError, UnauthorizedError };
