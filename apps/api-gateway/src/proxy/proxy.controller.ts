import { Controller, All, Req, Res, Body, Query, Headers, Param, RequestMethod } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ProxyService } from './proxy.service';
import { Method } from 'axios';

@ApiTags('Microservice Ingress Proxy')
@Controller()
export class ProxyController {
  constructor(private readonly proxyService: ProxyService) {}

  @All('auth/*')
  @ApiOperation({ summary: 'Proxy routing to Auth Microservice' })
  async proxyAuth(@Req() req: Request, @Body() body: any, @Query() query: any, @Headers() headers: any) {
    const path = req.path.replace(/^\/api\/v1\//, '');
    const method = req.method as Method;
    return this.proxyService.forwardRequest('auth', path, method, body, headers, query);
  }

  @All('workflows/*')
  @ApiOperation({ summary: 'Proxy routing to Workflow Microservice' })
  async proxyWorkflow(@Req() req: Request, @Body() body: any, @Query() query: any, @Headers() headers: any) {
    const path = req.path.replace(/^\/api\/v1\//, '');
    const method = req.method as Method;
    return this.proxyService.forwardRequest('workflow', path, method, body, headers, query);
  }

  @All('notifications/*')
  @ApiOperation({ summary: 'Proxy routing to Notification Microservice' })
  async proxyNotification(@Req() req: Request, @Body() body: any, @Query() query: any, @Headers() headers: any) {
    const path = req.path.replace(/^\/api\/v1\//, '');
    const method = req.method as Method;
    return this.proxyService.forwardRequest('notification', path, method, body, headers, query);
  }
}
