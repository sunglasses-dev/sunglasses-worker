// Test-only worker: runs the regexes it is given and reports where each one matches (null = no match).
// It exists so a test can ask the serving runtime (workerd), not node, what a regex does.
export default {
  async fetch(request) {
    const { cases } = await request.json();
    const out = cases.map(({ source, flags, text }) => {
      try {
        const m = new RegExp(source, flags).exec(text);
        return m ? m.index : null;
      } catch (e) {
        return "ERR " + e.message;
      }
    });
    return Response.json({ out });
  },
};
