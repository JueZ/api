import { ChangeDetectionStrategy, Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <main class="shell" aria-labelledby="project-title">
      <section class="hero">
        <p class="eyebrow">Personal API catalogue</p>
        <h1 id="project-title">JueZ API Catalogue</h1>
        <p class="lede">
          A thin, serverless v0 foundation for publishing personal API integrations.
        </p>
      </section>

      <section class="card" aria-labelledby="catalogue-title">
        <h2 id="catalogue-title">API catalogue placeholder</h2>
        <p>
          Integrations will appear here in later milestones. Reddit is intentionally not
          implemented in this Hello World skeleton.
        </p>
      </section>

      <section class="card" aria-labelledby="hello-title">
        <h2 id="hello-title">Test <code>/api/hello</code> later</h2>
        <p>
          Once the Azure Functions backend is running, call <code>GET /api/hello</code>
          to verify the platform path end to end.
        </p>
        <a class="button" href="/api/hello" aria-label="Open the hello API endpoint">
          Open hello endpoint
        </a>
      </section>

      <aside class="notice" role="note">
        Production authentication is not fully implemented yet. JWT enforcement is planned
        for the next milestone.
      </aside>
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {}

bootstrapApplication(AppComponent).catch((error: unknown) => {
  console.error('Failed to bootstrap Angular application.', error);
});
