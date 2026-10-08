import { builtinModules } from 'module';
import type { ErrorCategory } from '../../types';

/**
 * 启动失败分类（PLAN §8.1）。
 * 纯函数、可单测；分类结果直接决定「能不能靠装依赖解决」。
 * 宁可判成不可安装（只提示），也不要误触发一次 npm install。
 */

export interface ClassifyOptions {
  /** 项目自己的包名，用于排除「自引用」误判 */
  selfName?: string | null;
}

export interface ClassifyResult {
  category: ErrorCategory;
  /** missing-module / missing-relative 时有值 */
  moduleName: string | null;
  /** 是否可以通过安装依赖解决 */
  installable: boolean;
  /** 给用户的可操作建议 */
  hint: string;
  /** 命中的原始行（便于 UI 高亮） */
  matchedLine: string | null;
}

const BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

const RULES: {
  category: ErrorCategory;
  re: RegExp;
  hint: string;
  installable: boolean;
}[] = [
  {
    category: 'command-not-found',
    re: /('|")([^'"]+)('|")\s+is not recognized as an internal or external command|command not found|不是内部或外部命令|spawn\s+\S+\s+ENOENT/i,
    hint: '找不到要执行的命令：检查命令名是否正确、PATH 是否可用，或改用「Node 直启」。',
    installable: false,
  },
  {
    category: 'port-in-use',
    re: /EADDRINUSE|address already in use|端口.*被占用/i,
    hint: '端口被占用：改用其他端口或关闭占用程序（可在编辑中开启自动选择空闲端口）。',
    installable: false,
  },
  {
    category: 'native-abi',
    re: /NODE_MODULE_VERSION|was compiled against a different Node\.js version|invalid ELF header|is not a valid Win32 application|Error: Cannot find module '[^']*\.node'|The specified module could not be found/i,
    hint: '原生模块与当前运行时 ABI 不匹配：请在内置 Node 下重装依赖（必要时允许执行安装脚本）。',
    installable: false,
  },
  {
    category: 'build-tool',
    re: /node-gyp|gyp ERR!|prebuild-install|node-pre-gyp|MSBuild|Visual Studio|gyp: No Xcode|需要编译环境/i,
    hint: '依赖需要本机编译（node-gyp/MSBuild/python），请先准备编译环境再重装依赖。',
    installable: false,
  },
  {
    category: 'missing-module',
    re: /Cannot find module '([^']+)'|Cannot find package '([^']+)'|ERR_MODULE_NOT_FOUND[^\n]*?'([^']+)'/i,
    hint: '缺少依赖模块，可以尝试安装依赖。',
    installable: true,
  },
  {
    category: 'permission',
    re: /EACCES|EPERM|EBUSY|Access is denied|拒绝访问|operation not permitted/i,
    hint: '权限不足或文件被占用：检查目录权限，或关闭正在占用文件的程序。',
    installable: false,
  },
  {
    category: 'network',
    re: /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|getaddrinfo|socket hang up/i,
    hint: '网络不可达：检查代理/镜像设置后重试。',
    installable: false,
  },
  {
    category: 'syntax',
    re: /SyntaxError|Unexpected token|ERR_REQUIRE_ESM|ERR_UNKNOWN_FILE_EXTENSION|cannot be used as a module|ERR_INVALID_ARG_TYPE/i,
    hint: '代码或模块格式问题（ESM/CJS、语法错误）：请检查入口与 package.json 的 type 字段。',
    installable: false,
  },
];

/** scoped 包名归一化：@scope/pkg/sub → @scope/pkg；pkg/sub → pkg */
export function packageNameFromSpecifier(specifier: string): string {
  const spec = specifier.trim();
  if (!spec) return '';
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split('/')[0];
}

/** 是否为「无法靠安装依赖解决」的说明符（相对/绝对路径、内置模块、自引用） */
export function isUninstallableSpecifier(
  specifier: string,
  selfName?: string | null
): boolean {
  const spec = (specifier ?? '').trim();
  if (!spec) return true;
  if (spec.startsWith('.') || spec.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(spec)) return true;
  if (spec.startsWith('node:')) return true;
  if (BUILTINS.has(spec)) return true;
  if (selfName && packageNameFromSpecifier(spec) === selfName) return true;
  return false;
}

export function classifyError(
  text: string,
  options: ClassifyOptions = {}
): ClassifyResult {
  const haystack = text ?? '';

  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('i') ? 'i' : '');
    const match = re.exec(haystack);
    if (!match) continue;

    if (rule.category === 'missing-module') {
      const specifier = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (isUninstallableSpecifier(specifier, options.selfName)) {
        const isNode = /\.node$/i.test(specifier);
        return {
          category: isNode ? 'native-abi' : 'missing-relative',
          moduleName: specifier || null,
          installable: false,
          hint: isNode
            ? '缺少已编译的原生模块文件：需要重新编译依赖，而不是安装新包。'
            : `模块 ${specifier || '(相对路径)'} 指向本地文件或内置模块，安装依赖无法解决，请检查入口/构建产物。`,
          matchedLine: firstMatchingLine(haystack, rule.re),
        };
      }
      return {
        category: 'missing-module',
        moduleName: packageNameFromSpecifier(specifier),
        installable: true,
        hint: rule.hint,
        matchedLine: firstMatchingLine(haystack, rule.re),
      };
    }

    return {
      category: rule.category,
      moduleName: null,
      installable: rule.installable,
      hint: rule.hint,
      matchedLine: firstMatchingLine(haystack, rule.re),
    };
  }

  return {
    category: 'unknown',
    moduleName: null,
    installable: false,
    hint: '未能识别失败原因，请查看完整日志。',
    matchedLine: null,
  };
}

function firstMatchingLine(text: string, re: RegExp): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (new RegExp(re.source, re.flags).test(line)) return line.trim();
  }
  return null;
}

/** 只把「缺少裸包」视为可自动安装 */
export function isInstallable(category: ErrorCategory): boolean {
  return category === 'missing-module';
}
