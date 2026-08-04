"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = exports.GatewayController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const metrics_service_1 = require("./metrics.service");
const dashboard_controller_1 = require("./dashboard.controller");
let GatewayController = class GatewayController {
    constructor(metricsService) {
        this.metricsService = metricsService;
    }
    getHealth() {
        return {
            status: 'ok',
            service: 'api-gateway',
            timestamp: new Date().toISOString(),
        };
    }
    async getMetrics(res) {
        const metrics = await this.metricsService.getMetrics();
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        return res.send(metrics);
    }
};
exports.GatewayController = GatewayController;
__decorate([
    (0, common_1.Get)('health'),
    (0, swagger_1.ApiOperation)({ summary: 'API Gateway Health Status' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], GatewayController.prototype, "getHealth", null);
__decorate([
    (0, common_1.Get)('metrics'),
    (0, swagger_1.ApiOperation)({ summary: 'Prometheus Metrics Endpoint' }),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], GatewayController.prototype, "getMetrics", null);
exports.GatewayController = GatewayController = __decorate([
    (0, swagger_1.ApiTags)('Gateway Observability'),
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [metrics_service_1.MetricsService])
], GatewayController);
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        controllers: [GatewayController, dashboard_controller_1.DashboardController],
        providers: [metrics_service_1.MetricsService],
        exports: [metrics_service_1.MetricsService],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map