import { IsString, IsOptional, IsObject } from 'class-validator';

export class TriggerExecutionDto {
  @IsString()
  @IsOptional()
  tenantId?: string;

  @IsObject()
  @IsOptional()
  metadata?: any;
}
