import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import axios, { AxiosRequestConfig, Method } from 'axios';
import { StructuredLogger } from '@forgegate/logger';

@Injectable()
export class ProxyService {
  private logger = new StructuredLogger('gateway-proxy');

  private authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
  private workflowServiceUrl = process.env.WORKFLOW_SERVICE_URL || 'http://localhost:3002';
  private notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3003';

  async forwardRequest(service: 'auth' | 'workflow' | 'notification', path: string, method: Method, body: any, headers: any, query: any) {
    const baseUrl = this.getServiceUrl(service);
    const targetUrl = `${baseUrl}/${path}`;

    const correlationId =
      headers['x-correlation-id'] ||
      headers['x-request-id'] ||
      `corr-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const config: AxiosRequestConfig = {
      url: targetUrl,
      method,
      data: ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) ? body : undefined,
      params: query,
      headers: {
        'content-type': headers['content-type'] || 'application/json',
        authorization: headers['authorization'] || '',
        'x-tenant-id': headers['x-tenant-id'] || '',
        'x-correlation-id': correlationId,
      },
      timeout: 10000,
    };

    const startTime = Date.now();
    try {
      const response = await axios(config);
      const durationMs = Date.now() - startTime;

      this.logger.logEvent('proxy_request_success', {
        service,
        targetUrl,
        method,
        statusCode: response.status,
        durationMs,
        correlationId,
      });

      return response.data;
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      const statusCode = error.response?.status || HttpStatus.BAD_GATEWAY;
      const message = error.response?.data || { error: 'Upstream service unavailable', details: error.message };

      this.logger.error(`Proxy failure to ${service} microservice at ${targetUrl}: ${error.message}`, error.stack, {
        service,
        targetUrl,
        statusCode,
        durationMs,
        correlationId,
      });

      throw new HttpException(message, statusCode);
    }
  }

  private getServiceUrl(service: 'auth' | 'workflow' | 'notification'): string {
    switch (service) {
      case 'auth':
        return this.authServiceUrl;
      case 'workflow':
        return this.workflowServiceUrl;
      case 'notification':
        return this.notificationServiceUrl;
    }
  }
}
