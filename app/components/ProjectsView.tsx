"use client";

export type ProjectId = "shkiot-adumot";

type ProjectsViewProps = {
  activeProject: ProjectId | null;
  onOpenProject: (projectId: ProjectId) => void;
  onCloseProject: () => void;
};

export default function ProjectsView({
  activeProject,
  onOpenProject,
  onCloseProject,
}: ProjectsViewProps) {
  return (
    <section className="view-section projects-view" aria-labelledby="projects-title">
      <header className="page-heading projects-heading">
        <div>
          <p>{activeProject ? "מרחב תרגול אישי" : "תרגול לפי יצירה"}</p>
          <h1 id="projects-title">{activeProject ? "שקיעות אדומות" : "פרויקטים"}</h1>
        </div>

        {activeProject ? (
          <button type="button" className="projects-back-button" onClick={onCloseProject}>
            <span aria-hidden="true">→</span>
            כל הפרויקטים
          </button>
        ) : (
          <span className="projects-count">פרויקט אחד</span>
        )}
      </header>

      {!activeProject && (
        <div className="projects-grid">
          <button
            type="button"
            className="project-card"
            onClick={() => onOpenProject("shkiot-adumot")}
            aria-label="פתיחת הפרויקט שקיעות אדומות"
          >
            <span className="project-card-art" aria-hidden="true">
              <span>𝄞</span>
              <i /><i /><i />
            </span>

            <span className="project-card-copy">
              <small>כינור · תרגול אינטראקטיבי</small>
              <strong>שקיעות אדומות</strong>
              <span>תווים, אצבוע, האטה, לופ והחלפת סולם — במקום אחד.</span>
            </span>

            <span className="project-card-meta" aria-hidden="true">
              <span>מי מינור</span>
              <span>70 תיבות</span>
            </span>

            <span className="project-card-action">
              פתיחת הפרויקט
              <span aria-hidden="true">←</span>
            </span>
          </button>
        </div>
      )}

      {activeProject === "shkiot-adumot" && (
        <article className="project-workspace" aria-labelledby="red-sunsets-project-title">
          <div className="project-workspace-toolbar">
            <div>
              <span>פרויקט כינור</span>
              <h2 id="red-sunsets-project-title">שקיעות אדומות</h2>
            </div>
            <a
              href="/projects/shkiot-adumot/index.html"
              target="_blank"
              rel="noreferrer"
            >
              פתיחה בחלון חדש
              <span aria-hidden="true">↗</span>
            </a>
          </div>

          <iframe
            className="project-frame"
            src="/projects/shkiot-adumot/index.html"
            title="נגן התרגול של שקיעות אדומות"
            allow="autoplay"
          />
        </article>
      )}
    </section>
  );
}
