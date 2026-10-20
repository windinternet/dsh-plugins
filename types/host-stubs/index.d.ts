/**
 * 宿主包的本地类型存根。
 *
 * 为什么需要它们：`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 随 DSH 一起分发，
 * 但不在公开 npm 上，因此本地无法安装、也就无法取得官方类型。没有存根的话，
 * 插件入口 index.js 的类型检查会整体失效——而入口正是最需要类型检查的地方。
 *
 * 重要限制，读之前先看这一段：
 * - 这些声明是**最小可用**的，依据是宿主 README 里的用法与真实调用点，
 *   **不是**官方 API 的完整或权威描述。
 * - 因此"本地类型检查通过"**不能**证明与真实宿主兼容。唯一的证明是把它装进
 *   DSH 跑一次真实调用，这也是本仓库不做端到端自动化测试时必须人工完成的一步。
 * - 宿主升级后这些存根可能过期。升级检查清单见 docs/references/dsh-plugin-api.md。
 */
declare module '@deepseek-ai/schemastery' {
  interface SchemaLike {
    default(value: unknown): SchemaLike;
    description(text: string): SchemaLike;
  }

  /** 只声明本仓库实际用到的构造器。 */
  const z: {
    string(): SchemaLike;
    number(): SchemaLike;
    natural(): SchemaLike;
    boolean(): SchemaLike;
    /** 任意 JSON 值。用于"形状由使用方自己解析"的字段，例如端口范围。 */
    any(): SchemaLike;
    const(value: unknown): SchemaLike;
    union(alternatives: unknown[]): SchemaLike;
    object(shape: Record<string, unknown>): SchemaLike;
    array(inner: unknown): SchemaLike;
  };

  export default z;
}

declare module '@deepseek-ai/dsh-tools' {
  /**
   * 参数声明：schema 部分按 JSON Schema 子集描述，这里只约束形状。
   *
   * `enum` 与属性级 `required` 都是从本机安装包核对过的真实字段
   * （见 docs/references/dsh-plugin-tools.md），不是猜的。
   */
  interface ParameterSpec {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json';
    required?: boolean;
    description?: string;
    title?: string;
    default?: unknown;
    examples?: unknown[];
    enum?: unknown[];
    const?: unknown;
    items?: ParameterSpec;
    properties?: Record<string, ParameterSpec>;
    additionalProperties?: boolean;
    oneOf?: ParameterSpec[];
  }

  /** 工具结果的展示内容块。当前宿主只支持文本块。 */
  interface ContentBlock {
    type: 'text';
    text: string;
  }

  interface OutputSpec {
    schema: unknown;
    render: (args: any, value: any) => ContentBlock[];
  }

  /** 执行上下文。只声明本仓库会读的字段。 */
  interface ToolExecution {
    signal: AbortSignal;
    agent?: unknown;
  }

  interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, ParameterSpec>;
    output: OutputSpec;
    execute: (args: any, exec: ToolExecution) => Promise<any>;
    /** 声明式超时。注册表不强制，供超时策略使用。 */
    timeoutMs?: number;
    /** 该调用能否与其他调用并发。 */
    isConcurrencySafe?: (args: any) => boolean;
    /** 是否延迟装载定义。 */
    deferLoading?: boolean;
  }

  /**
   * 构造一个类型化工具定义。真实实现会依据 parameters 与 output 推导
   * execute 的参数与返回值类型；存根做不到这一点，因此这里回退为宽类型。
   */
  export function defineTool(definition: ToolDefinition): ToolDefinition;
}
