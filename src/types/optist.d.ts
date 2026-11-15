declare module 'optist' {
  /** One option definition for {@link Optist.opts}. */
  interface OptDef {
    shortName?: string | string[];
    longName?: string | string[];
    hasArg?: boolean;
    required?: boolean;
    defaultValue?: string;
    multi?: boolean;
    optArgCb?: (arg: string, name?: string) => unknown;
    requiresAlso?: string | string[];
    conflictsWith?: string | string[];
    /** Environment variable used as the value when the option is not on the command line. */
    environment?: string;
    description?: string;
  }

  class Optist {
    opts(defs: Optist.OptDef[]): this;
    describeOpt(name: string, description: string): this;
    describeParam(num: number, name: string, description?: string): this;
    additional(restRequireMin?: number, restRequireMax?: number): this;
    help(command?: string): this;
    helpMessageHead(text: string): this;
    helpMessageTail(text: string): this;
    parse(av?: string[], restRequireMin?: number, restRequireMax?: number): this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value(name: string): any;
    values(): Record<string, unknown>;
    rest(): string[];
    showErrorMessageHelpAndExitIfHelpEnabled(message: string, exitValue?: number): this;
  }

  namespace Optist {
    export type { OptDef };
  }

  export = Optist;
}

declare module 'optist/util.js' {
  type Cb<T> = (arg: string) => T | undefined;
  const util: {
    nonEmptyCb: Cb<string>;
    integerCb: Cb<number>;
    integerListCb: Cb<number[]>;
    integerWithLimitsCbFactory(min?: number, max?: number): Cb<number>;
    allowListCbFactory(allowed: string | RegExp | (string | RegExp)[]): Cb<string>;
    existingFileNameCb: Cb<string>;
    fileContentsStringCb: Cb<string>;
    ipv4: Cb<string>;
    jsonObject: Cb<Record<string, unknown>>;
    jsonArray: Cb<unknown[]>;
  };
  export = util;
}
