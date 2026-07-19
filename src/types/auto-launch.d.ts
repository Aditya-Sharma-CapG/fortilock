declare module "auto-launch" {
  interface Options {
    name: string;
    path?: string;
    isHidden?: boolean;
  }

  class AutoLaunch {
    constructor(options: Options);
    enable(): Promise<void>;
    disable(): Promise<void>;
    isEnabled(): Promise<boolean>;
  }

  export default AutoLaunch;
}
