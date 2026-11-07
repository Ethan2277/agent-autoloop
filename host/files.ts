// POSIX modes do not protect Windows secrets. A private directory gives new files only the owner's and SYSTEM's access.
import { chmodSync, mkdirSync } from "node:fs";
import { powershell, psQuote } from "./command.ts";

export function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") return chmodSync(directory, 0o700);
  powershell(`
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $folder = ${psQuote(directory)}
    # Setting even the same owner needs the right to take ownership, which a data drive's Modify doesn't give.
    if ([IO.Directory]::GetAccessControl($folder, 'Owner').GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) {
      $acl.SetOwner($owner)
    }
    foreach ($sid in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    [IO.Directory]::SetAccessControl($folder, $acl)
  `);
}
