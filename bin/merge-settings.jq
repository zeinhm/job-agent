# bin/cc-run: jq -s -f bin/merge-settings.jq <role settings> <owner overrides>
# Objects merge key by key (the overrides win); arrays are replaced, except permissions.deny, which is the union of both
# lists, so an override can never remove a role's deny rule.
.[0] as $base | .[1] as $ov
| ($base * $ov)
| ((($base.permissions.deny // []) + ($ov.permissions.deny // [])) | unique) as $deny
| if ($deny | length) > 0 then .permissions.deny = $deny else . end
