# Native reset-policy writer propagation

`createSubagentSettings` preserves the parent Settings effective snapshot and attaches the exact borrowed reset-policy writer token. The shared constructor covers structured task/eval, vibe, and persisted cold-revival children. Child cleanup does not own or dispose the writer; the original Settings remains its owner.

The token only permits persistence of the four reset-policy settings. Propagation does not clear project, overlay, or runtime overrides and does not create standing consent or initiate provider/reset activity.
