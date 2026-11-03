import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsString, MaxLength } from 'class-validator';

export class CreateProfileDto {
  @ApiProperty({ description: 'Profile name (unique per tool)', example: 'production' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  name: string;

  @ApiProperty({ description: 'Tool-specific configuration object. The reserved `customArgs` string holds extra command-line arguments for tools that support them (workspace admin only).', example: { severity: ['high'] } })
  @IsObject()
  config: Record<string, unknown>;
}
