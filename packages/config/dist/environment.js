"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.commonConfigSchema = void 0;
const Joi = require("joi");
exports.commonConfigSchema = Joi.object({
    PORT: Joi.number().default(3000),
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
    DATABASE_URL: Joi.string().required(),
    REDIS_HOST: Joi.string().default('localhost'),
    REDIS_PORT: Joi.number().default(6379),
});
//# sourceMappingURL=environment.js.map