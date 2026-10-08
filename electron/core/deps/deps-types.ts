import type { ProjectManifest, RuntimeInfo } from '../../types';

/** 依赖安装请求 */
export interface DepsInstallRequest {
  projectId: string;
  manifest: ProjectManifest;
  workDir: string;
  runtime: RuntimeInfo;
  /** 是否允许执行 postinstall 等脚本（默认 false → --ignore-scripts） */
  allowScripts: boolean;
  /** 用途说明，仅用于日志与 UI 文案 */
  reason: 'preflight' | 'missing-module' | 'manual' | 'reinstall';
  /** 触发安装的模块名（missing-module 场景） */
  moduleName?: string | null;
}

export interface DepsInstallResult {
  ok: boolean;
  /** 实际执行的命令（展示用） */
  command: string;
  exitCode: number | null;
  /** 输出尾部，失败时用于展示 */
  outputTail: string;
  /** 用户取消 */
  cancelled: boolean;
  error?: string;
}

/** 依赖服务（M4 实现），启动流水线只依赖这个接口 */
export interface DepsService {
  install(request: DepsInstallRequest): Promise<DepsInstallResult>;
  cancel(projectId: string): void;
  isInstalling(projectId: string): boolean;
}

/** 需要用户裁决的依赖提示 */
export type DepsPromptKind =
  | 'preflight-missing'
  | 'runtime-missing-module'
  | 'runtime-native-abi';

export interface DepsPrompt {
  projectId: string;
  kind: DepsPromptKind;
  moduleName: string | null;
  message: string;
  detail: string;
  /** 建议动作文案 */
  installLabel: string;
}

export type DepsPromptAction = 'install' | 'install-allow-scripts' | 'skip' | 'cancel';
