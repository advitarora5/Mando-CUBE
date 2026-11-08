// Preserve the full company list for duplicate matching. Score touched companies,
// and research contacts only for new admissions in this execution.
export function discoveryScoreScope(store) {
  const touched = new Set(), admitted = new Set();
  const companies = store.companies.bind(store);
  const assign = store.assignSignals.bind(store);
  store.assignSignals = async (ids, target) => {
    await assign(ids, target);
    if (target.company_id) touched.add(target.company_id);
  };
  for (const method of ['createPipelineCompany', 'admitReview']) {
    const original = store[method].bind(store);
    store[method] = async (...options) => {
      const id = await original(...options);
      touched.add(id);
      if (method === 'createPipelineCompany' || options[3] == null) admitted.add(id);
      return id;
    };
  }
  return plan => {
    const scope = plan === 'score' ? touched : plan === 'enrich' ? admitted : null;
    store.companies = scope ? async () => scope.size ? (await companies()).filter(c => scope.has(c.id)) : [] : companies;
  };
}
