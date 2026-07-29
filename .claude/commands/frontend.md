Start the local development server for the ELI Coffee Events frontend.

This project has no build step — files are served as static assets.

Run this command in the project root:

```
npx vercel dev
```

This mirrors the Vercel production environment including `cleanUrls: true` from `vercel.json`.

Alternatively, for a plain static server:

```
npx serve .
```

The site will be available at http://localhost:3000 (vercel dev) or http://localhost:3000 (serve).
