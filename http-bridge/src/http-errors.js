module.exports = class HttpError extends Error {
  constructor(httpCode, message, options) {
    super(message, options);
    this.httpCode = httpCode;
    this.name = this.constructor.name;
  }
}