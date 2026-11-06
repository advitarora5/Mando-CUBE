// Preserve the full company list for duplicate matching; narrow only the scoring pass.
export function discoveryScoreScope(store) {
  const touched = new Set();
  const companies = store.companies.bind(store);
  const assign = store.assignSignals.bind(store);
  store.assignSignals = async (ids, target) => {
    await assign(ids, target);
    if (target.company_id) touched.add(target.company_id);
  };
  for (const method of ['createPipelineCompany', 'admitReview']) {
    const original = store[method].bind(store);
    store[method] = async (...options) => { const id = await original(...options); touched.add(id); return id; };
  }
  return plan => { store.companies = plan === 'score' ? async () => (await companies()).filter(c => touched.has(c.id)) : companies; };
}
