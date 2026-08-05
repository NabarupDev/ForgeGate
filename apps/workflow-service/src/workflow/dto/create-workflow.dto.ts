import { IsString, IsNotEmpty, IsOptional, IsArray, ValidateNested, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class WorkflowStepDto {
  @IsInt()
  @IsOptional()
  stepOrder?: number;

  @IsString()
  @IsOptional()
  actionType?: string;

  @IsOptional()
  config?: any;

  @IsInt()
  @IsOptional()
  retryLimit?: number;
}

export class CreateWorkflowDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  triggerType?: string;

  @IsString()
  @IsNotEmpty()
  createdById!: string;

  @IsString()
  @IsNotEmpty()
  tenantId!: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepDto)
  steps?: WorkflowStepDto[];
}
