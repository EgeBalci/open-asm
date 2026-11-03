export default function bindingCommand(command: string, args: object): string {
  const commandBuilder = Object.entries(args).reduce((cmd, [key, value]) => {
    // Function replacer: `$&`/`$1` in a value must stay literal, not expand.
    return cmd.replace(new RegExp(`{{${key}}}`, 'g'), () => String(value));
  }, command);
  return commandBuilder;
}
