// A fixture module that passes the loader's former shallow check while omitting
// required KnowledgePack and PresentationPack members. Loading it must report
// pack_export_invalid before a downstream CLI call can dereference the missing
// member.
const incompletePack = {
  id: "invalid-demo",
  version: "0.1.0",
  validateEnvelope: () => ({ ok: true, value: undefined }),
  retrievalPolicy: {},
};

export default incompletePack;