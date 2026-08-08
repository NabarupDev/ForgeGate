module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@forgegate/common$': '<rootDir>/packages/common/src/index.ts',
    '^@forgegate/logger$': '<rootDir>/packages/logger/src/logger.service.ts',
    '^@forgegate/auth$': '<rootDir>/packages/auth/src/index.ts',
    '^@forgegate/config$': '<rootDir>/packages/config/src/index.ts',
  },
};
