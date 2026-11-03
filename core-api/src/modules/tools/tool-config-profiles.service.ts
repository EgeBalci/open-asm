import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { WorkerType } from '@/common/enums/enum';
import {
  ConnectorRegistryService,
  type ConnectorManifestEntry,
} from '@/modules/connectors/connector-registry.service';
import { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import { ToolConfigProfile } from './entities/tool-config-profiles.entity';
import { Tool } from './entities/tools.entity';
import {
  CUSTOM_ARGS_KEY,
  CUSTOM_ARGS_MAX_LENGTH,
  parseCustomArgs,
  supportsCustomArgs,
} from './custom-args';
import {
  decryptProfile,
  deepMerge,
  encryptProfile,
  getSensitiveFields,
  isMaskedValue,
  maskProfile,
} from './validators/tool-config-profiles.crypto';
import { validateProfileOrThrow } from './validators/tool-config-profiles.validator';

interface JobRef { id: string; }
interface WfRef { name: string; wf_id: string; }

@Injectable()
export class ToolConfigProfilesService {
  private readonly logger = new Logger(ToolConfigProfilesService.name);

  constructor(
    @InjectRepository(ToolConfigProfile)
    private readonly profilesRepo: Repository<ToolConfigProfile>,
    @InjectRepository(Tool)
    private readonly toolsRepo: Repository<Tool>,
    private readonly connectorRegistry: ConnectorRegistryService,
    private readonly encryptionService: WorkspaceEncryptionService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Resolves the connector schema for a given tool row.
   * The schema is the connector configSchema.
   * Tool.name IS the connector slug (e.g. "nuclei").
   */
  private async resolveConnectorSchema(toolId: string) {
    const tool = await this.toolsRepo.findOne({ where: { id: toolId } });
    if (!tool) {
      throw new BadRequestException(`Tool ${toolId} not found`);
    }
    const entry = this.connectorRegistry.getConnector(tool.name);
    // Built-ins have no schema; their profiles only carry customArgs.
    if (!entry && tool.type === WorkerType.BUILT_IN) {
      return { tool, entry: null, schema: null, sensitiveFields: [] };
    }
    if (!entry) {
      throw new BadRequestException(
        `Unknown tool "${tool.name}" -- cannot validate config`,
      );
    }
    // A known connector without a configSchema needs no config — profile creation stays allowed and validation
    // is skipped (config stored as-is, no sensitive fields to encrypt).
    const schema = entry.configSchema ?? null;
    if (!schema) {
      return {
        tool,
        entry,
        schema: null,
        sensitiveFields: [],
      };
    }
    return {
      tool,
      entry,
      schema,
      sensitiveFields: getSensitiveFields(schema),
    };
  }

  /**
   * Encrypts config fields and saves the profile.
   */
  private async encryptAndSave(
    profile: ToolConfigProfile,
    sensitiveFields: string[],
    workspaceId: string,
  ): Promise<ToolConfigProfile> {
    const dek = await this.encryptionService.getDEK(workspaceId);
    const encryptedConfig = encryptProfile(
      profile.config,
      sensitiveFields,
      dek,
    );
    profile.config = encryptedConfig;
    return this.profilesRepo.save(profile);
  }

  /**
   * Masks sensitive fields for API responses.
   */
  private maskConfig(
    profile: ToolConfigProfile,
  ): ToolConfigProfile {
    // Defensive: some callers do not eager-load the tool relation.
    // Without it there is no schema to consult — return unmasked.
    if (!profile.tool) return profile;
    const entry = this.connectorRegistry.getConnector(
      (profile.tool).name,
    );
    if (!entry) return profile;
    // configSchema drives sensitive field detection
    const schema = entry.configSchema;
    if (!schema) return profile;
    const sensitiveFields = getSensitiveFields(schema);
    if (sensitiveFields.length === 0) return profile;
    const copy = { ...profile, config: maskProfile(profile.config, sensitiveFields) };
    return copy;
  }

  /**
   * Checks the reserved `customArgs` key and returns the config without it for
   * schema validation (connector schemas forbid unknown keys). The args reach
   * the tool's command line, so only workspace admins may change them.
   */
  private withoutCustomArgs(
    tool: Tool,
    entry: ConnectorManifestEntry | null,
    config: Record<string, unknown>,
    previous: unknown,
    isAdmin: boolean,
  ): Record<string, unknown> {
    const rest = { ...config };
    const args = rest[CUSTOM_ARGS_KEY];
    delete rest[CUSTOM_ARGS_KEY];
    if ((args ?? '') !== (previous ?? '') && !isAdmin) {
      throw new ForbiddenException(
        'Only workspace admins can change custom arguments',
      );
    }
    if (args !== undefined && args !== '') {
      if (typeof args !== 'string' || args.length > CUSTOM_ARGS_MAX_LENGTH) {
        throw new BadRequestException(
          `customArgs must be a string of at most ${CUSTOM_ARGS_MAX_LENGTH} characters`,
        );
      }
      if (!supportsCustomArgs(tool.name, entry)) {
        throw new BadRequestException(
          `Tool "${tool.name}" does not support custom arguments`,
        );
      }
      try {
        parseCustomArgs(args);
      } catch (error) {
        throw new BadRequestException(
          `Invalid customArgs: ${(error as Error).message}`,
        );
      }
    }
    if (!entry && Object.keys(rest).length > 0) {
      throw new BadRequestException(
        `Built-in tool "${tool.name}" only accepts customArgs`,
      );
    }
    return rest;
  }

  // ── CRUD ─────────────────────────────────────────────────────────────

  async create(
    workspaceId: string,
    toolId: string,
    dto: { name: string; config: Record<string, unknown> },
    isAdmin = false,
  ): Promise<ToolConfigProfile> {
    const { tool, entry, schema, sensitiveFields } =
      await this.resolveConnectorSchema(toolId);
    const toolConfig = this.withoutCustomArgs(
      tool,
      entry,
      dto.config,
      undefined,
      isAdmin,
    );

    // Validate config against schema (I3) — skipped for connectors without a
    // config schema (their config is stored as-is, no validation possible).
    if (schema) {
      validateProfileOrThrow(
        this.connectorRegistry,
        tool.name,
        toolConfig,
      );
    }

    // Pre-check unique name (I1)
    const existing = await this.profilesRepo.findOne({
      where: {
        workspace: { id: workspaceId },
        tool: { id: toolId },
        name: dto.name,
      },
    });
    if (existing) {
      throw new ConflictException(
        `Profile name "${dto.name}" already exists for this tool`,
      );
    }

    // First profile for this workspace+tool → auto-set as default.
    // Subsequent profiles are never default by creation; use setDefault API.
    const count = await this.profilesRepo.count({
      where: {
        workspace: { id: workspaceId },
        tool: { id: toolId },
      },
    });
    const isFirstProfile = count === 0;

    const profile = this.profilesRepo.create({
      workspace: { id: workspaceId },
      tool: { id: toolId },
      name: dto.name,
      config: dto.config,
      isDefault: isFirstProfile,
    });

    // Encrypt secrets (I4), then persist
    return this.encryptAndSave(profile, sensitiveFields, workspaceId);
  }

  /**
   * Updates a profile's name and/or config.
   *
   * Config handling (when `dto.config` is provided):
   * 1. Validate against the connector schema first. A masked placeholder is a
   *    non-empty string, so JSON-Schema `required` still passes.
   * 2. For each sensitive field whose incoming value is a masked placeholder
   *    (see isMaskedValue), delete it from the incoming config and carry over
   *    the EXISTING stored ciphertext unchanged. This is what protects a real
   *    secret from being overwritten when the console echoes back the masked
   *    value the API returned.
   * 3. Encrypt only the genuinely-new incoming fields, then merge the carried
   *    ciphertext back on top: `{ ...encryptedIncoming, ...preservedFields }`.
   *    Carried ciphertext is never re-encrypted (double-encrypt is a known bug).
   *
   * Rename-only (no `dto.config`) persists as-is without touching ciphertext.
   */
  async update(
    workspaceId: string,
    profileId: string,
    dto: {
      name?: string;
      config?: Record<string, unknown>;
    },
    isAdmin = false,
  ): Promise<ToolConfigProfile> {
    const profile = await this.findOwned(workspaceId, profileId);

    // Resolve schema via tool's slug
    const toolId = (profile.tool as unknown as { id: string }).id;
    const { tool, entry, schema, sensitiveFields } =
      await this.resolveConnectorSchema(toolId);

    // If name is changing, check uniqueness (I1)
    if (dto.name && dto.name !== profile.name) {
      const dup = await this.profilesRepo.findOne({
        where: {
          workspace: { id: workspaceId },
          tool: { id: toolId },
          name: dto.name,
        },
      });
      if (dup) {
        throw new ConflictException(
          `Profile name "${dto.name}" already exists for this tool`,
        );
      }
      profile.name = dto.name;
    }

    // Validate updated config (I3) — skipped for no-schema connectors
    if (dto.config !== undefined) {
      const toolConfig = this.withoutCustomArgs(
        tool,
        entry,
        dto.config,
        profile.config?.[CUSTOM_ARGS_KEY],
        isAdmin,
      );
      if (schema) {
        validateProfileOrThrow(this.connectorRegistry, tool.name, toolConfig);
      }
    }

    // No config change (rename only): persist as-is. Re-running
    // encryptAndSave here would encrypt already-encrypted ciphertext
    // (double-encrypt), which decryptProfile then cannot fully unwrap.
    if (dto.config === undefined) {
      return this.profilesRepo.save(profile);
    }

    // Preserve masked secrets: carry over existing ciphertext for any sensitive
    // field whose incoming value is a mask placeholder (e.g. "****1234").
    const incoming: Record<string, unknown> = { ...dto.config };
    const preserved: Record<string, unknown> = {};
    for (const field of sensitiveFields) {
      if (field in incoming && isMaskedValue(incoming[field])) {
        if (field in profile.config) {
          preserved[field] = profile.config[field];
        }
        delete incoming[field];
      }
    }

    // Encrypt only the genuinely-new incoming fields (I4)
    const dek = await this.encryptionService.getDEK(workspaceId);
    const encryptedIncoming = encryptProfile(incoming, sensitiveFields, dek);
    profile.config = { ...encryptedIncoming, ...preserved };

    return this.profilesRepo.save(profile);
  }

  /**
   * Transactionally switch the default profile (I2).
   * Unsets the previous default, then sets the new one -- single transaction.
   */
  async setDefault(
    workspaceId: string,
    profileId: string,
  ): Promise<ToolConfigProfile> {
    const target = await this.findOwned(workspaceId, profileId);
    const toolId = (target.tool as unknown as { id: string }).id;

    return this.dataSource.transaction(async (manager) => {
      // Find current default for same workspace+tool
      const currentDefault = await manager.findOne(ToolConfigProfile, {
        where: {
          workspace: { id: workspaceId },
          tool: { id: toolId },
          isDefault: true,
        },
      });

      // Unset old default
      if (currentDefault && currentDefault.id !== profileId) {
        currentDefault.isDefault = false;
        await manager.save(currentDefault);
      }

      // Set new default
      target.isDefault = true;
      return manager.save(target);
    });
  }

  async remove(
    workspaceId: string,
    profileId: string,
  ): Promise<void> {
    const profile = await this.findOwned(workspaceId, profileId);
    const toolId = (profile.tool as unknown as { id: string }).id;
    const wasDefault = profile.isDefault;

    // ── Fail-fast: check for active references BEFORE delete ───────────

    // Check jobs table for direct configProfileId usage
    const jobRefs = (await this.dataSource.query(
      `SELECT j.id FROM "jobs" j
       JOIN "assets" a ON a.id = j."assetId"
       JOIN "targets" t ON t.id = a."targetId"
       WHERE j."configProfileId" = $1 AND t."workspaceId" = $2
       LIMIT 1`,
      [profileId, workspaceId],
    )) as unknown as JobRef[];
    if (jobRefs && jobRefs.length > 0) {
      throw new ConflictException(
        `Cannot delete profile ${profileId}: referenced by Job #${jobRefs[0].id}`,
      );
    }

    // Check workflows content JSONB for configProfileId in jobs[]
    const wfRefs = (await this.dataSource.query(
      `SELECT w.name, w.id AS wf_id FROM workflows w
       WHERE w."workspaceId" = $1
       AND w.content->'jobs' IS NOT NULL
       AND w.content->'jobs' @> $2::jsonb`,
      [workspaceId, JSON.stringify([{ configProfileId: profileId }])],
    )) as unknown as WfRef[];
    if (wfRefs && wfRefs.length > 0) {
      throw new ConflictException(
        `Cannot delete profile ${profileId}: referenced by Workflow ${wfRefs[0].name} (#${wfRefs[0].wf_id})`,
      );
    }

    await this.profilesRepo.remove(profile);

    // If the deleted profile was the default, auto-assign the next remaining
    // profile as the new default so there is always a default when profiles exist.
    if (wasDefault) {
      const next = await this.profilesRepo.findOne({
        where: {
          workspace: { id: workspaceId },
          tool: { id: toolId },
        },
        order: { createdAt: 'ASC' },
      });
      if (next) {
        next.isDefault = true;
        await this.profilesRepo.save(next);
      }
    }
  }

  async list(
    workspaceId: string,
    toolId: string,
  ): Promise<ToolConfigProfile[]> {
    const profiles = await this.profilesRepo.find({
      where: {
        workspace: { id: workspaceId },
        tool: { id: toolId },
      },
      relations: ['tool'],
      order: { createdAt: 'DESC' },
    });

    return profiles.map((p) => this.maskConfig(p));
  }

  async getOne(
    workspaceId: string,
    profileId: string,
  ): Promise<ToolConfigProfile> {
    const profile = await this.findOwned(workspaceId, profileId);
    return this.maskConfig(profile);
  }

  // ── Dispatch helpers ──────────────────────────────────────────────────

  /**
   * Validates that a config profile belongs to the given workspace AND tool.
   * Throws BadRequestException if the profile exists but belongs to a different tool.
   */
  async assertProfileOwnership(
    workspaceId: string,
    profileId: string,
    toolId: string,
  ): Promise<void> {
    const profile = await this.findOwned(workspaceId, profileId);
    const profileToolId = (profile.tool as unknown as { id: string }).id;
    if (profileToolId !== toolId) {
      throw new BadRequestException(
        `Profile ${profileId} does not belong to tool ${toolId}`,
      );
    }
  }

  /**
   * Resolves decrypted config for job dispatch.
   * Priority: explicit profileId → default profile for (workspace, tool) → none.
   * Returns decrypted config or undefined.
   */
  async resolveConfigForDispatch(
    workspaceId: string,
    toolId: string,
    profileId?: string,
  ): Promise<Record<string, unknown> | undefined> {
    let profile: ToolConfigProfile | null = null;

    if (profileId) {
      // Explicit profile — must belong to same workspace AND tool
      profile = await this.profilesRepo.findOne({
        where: { id: profileId },
        relations: ['workspace', 'tool'],
      });
      if (!profile) {
        throw new NotFoundException(`ToolConfigProfile ${profileId} not found`);
      }

      const profileWsId = (profile.workspace as unknown as { id: string }).id;
      const profileToolId = (profile.tool as unknown as { id: string }).id;
      if (profileWsId !== workspaceId || profileToolId !== toolId) {
        throw new NotFoundException(`ToolConfigProfile ${profileId} not found`);
      }
    } else {
      // Default profile for this workspace + tool
      profile = await this.profilesRepo.findOne({
        where: {
          workspace: { id: workspaceId },
          tool: { id: toolId },
          isDefault: true,
        },
      });
    }

    if (!profile) return undefined;

    // Get tool for schema lookup
    const tool = await this.toolsRepo.findOne({ where: { id: toolId } });
    if (!tool) return undefined;

    const entry = this.connectorRegistry.getConnector(tool.name);
    const schema = entry?.configSchema;
    if (!schema) return profile.config;

    const sensitiveFields = getSensitiveFields(schema);
    if (sensitiveFields.length === 0) return profile.config;

    const dek = await this.encryptionService.getDEK(workspaceId);
    return decryptProfile(profile.config, sensitiveFields, dek);
  }

  /**
   * Resolves merged config for a workflow job.
   * Loads base profile (by configProfileId or default), then deep-merges
   * with decrypted inline config if present.
   */
  async resolveConfigForJob(
    workspaceId: string,
    toolId: string,
    ref: { config?: Record<string, unknown>; configProfileId?: string },
  ): Promise<Record<string, unknown> | undefined> {
    const base =
      (await this.resolveConfigForDispatch(
        workspaceId,
        toolId,
        ref.configProfileId,
      )) ?? {};

    // customArgs comes only from the admin-gated profile, never inline config.
    const inline = { ...ref.config };
    delete inline[CUSTOM_ARGS_KEY];

    if (Object.keys(inline).length === 0) {
      return Object.keys(base).length > 0 ? tokenizeCustomArgs(base) : undefined;
    }

    // Decrypt inline config sensitive fields
    const tool = await this.toolsRepo.findOne({ where: { id: toolId } });
    if (!tool) return inline;

    const entry = this.connectorRegistry.getConnector(tool.name);
    const schema = entry?.configSchema;
    const sensitiveFields = getSensitiveFields(schema);

    let inlineConfig = inline;
    if (sensitiveFields.length > 0) {
      const dek = await this.encryptionService.getDEK(workspaceId);
      inlineConfig = decryptProfile(inline, sensitiveFields, dek);
    }

    return tokenizeCustomArgs(deepMerge(base, inlineConfig));
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async findOwned(
    workspaceId: string,
    profileId: string,
  ): Promise<ToolConfigProfile> {
    const profile = await this.profilesRepo.findOne({
      where: { id: profileId },
      relations: ['workspace', 'tool'],
    });
    if (!profile) {
      throw new NotFoundException(`Profile ${profileId} not found`);
    }
    const profileWsId = (profile.workspace as unknown as { id: string }).id;
    if (profileWsId !== workspaceId) {
      throw new NotFoundException(`Profile ${profileId} not found`);
    }
    return profile;
  }
}

/** Connectors receive customArgs pre-split into argv tokens (sdk connector.CustomArgs). */
function tokenizeCustomArgs(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const args = config[CUSTOM_ARGS_KEY];
  if (typeof args !== 'string') return config;
  return { ...config, [CUSTOM_ARGS_KEY]: parseCustomArgs(args) };
}
