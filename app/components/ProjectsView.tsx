"use client";

export type ProjectId = "shkiot-adumot" | "lomedet-laof";

type ProjectDefinition = {
  id: ProjectId;
  title: string;
  eyebrow: string;
  description: string;
  meta: readonly [string, string];
  path: string;
  frameTitle: string;
  artTone: "green" | "rose";
};

const PROJECTS: readonly ProjectDefinition[] = [
  {
    id: "shkiot-adumot",
    title: "שקיעות אדומות",
    eyebrow: "כינור · תרגול אינטראקטיבי",
    description: "תווים, אצבוע, האטה, לופ והחלפת סולם — במקום אחד.",
    meta: ["מי מינור", "70 תיבות"],
    path: "/projects/shkiot-adumot/index.html",
    frameTitle: "נגן התרגול של שקיעות אדומות",
    artTone: "green",
  },
  {
    id: "lomedet-laof",
    title: "לומדת לעוף",
    eyebrow: "כינור · תרגול פזמון",
    description: "תווים לפזמון, אצבוע, האטה, לופ והחלפת סולם — עם סימון חי.",
    meta: ["לה מז׳ור", "9 תיבות"],
    path: "/projects/lomedet-laof/index.html",
    frameTitle: "נגן הפזמון של לומדת לעוף",
    artTone: "rose",
  },
];

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
  const activeProjectData = PROJECTS.find((project) => project.id === activeProject) ?? null;

  return (
    <section className="view-section projects-view" aria-labelledby="projects-title">
      <header className="page-heading projects-heading">
        <div>
          <p>{activeProjectData ? "מרחב תרגול אישי" : "תרגול לפי יצירה"}</p>
          <h1 id="projects-title">{activeProjectData?.title ?? "פרויקטים"}</h1>
        </div>

        {activeProjectData ? (
          <button type="button" className="projects-back-button" onClick={onCloseProject}>
            <span aria-hidden="true">→</span>
            כל הפרויקטים
          </button>
        ) : (
          <span className="projects-count">{PROJECTS.length} פרויקטים</span>
        )}
      </header>

      {!activeProjectData && (
        <div className="projects-grid">
          {PROJECTS.map((project) => (
            <button
              key={project.id}
              type="button"
              className="project-card"
              onClick={() => onOpenProject(project.id)}
              aria-label={`פתיחת הפרויקט ${project.title}`}
            >
              <span
                className={`project-card-art project-card-art--${project.artTone}`}
                aria-hidden="true"
              >
                <span>𝄞</span>
                <i /><i /><i />
              </span>

              <span className="project-card-copy">
                <small>{project.eyebrow}</small>
                <strong>{project.title}</strong>
                <span>{project.description}</span>
              </span>

              <span className="project-card-meta" aria-hidden="true">
                {project.meta.map((item) => <span key={item}>{item}</span>)}
              </span>

              <span className="project-card-action">
                פתיחת הפרויקט
                <span aria-hidden="true">←</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {activeProjectData && (
        <article
          className="project-workspace"
          aria-labelledby={`${activeProjectData.id}-project-title`}
        >
          <div className="project-workspace-toolbar">
            <div>
              <span>פרויקט כינור</span>
              <h2 id={`${activeProjectData.id}-project-title`}>{activeProjectData.title}</h2>
            </div>
            <a href={activeProjectData.path} target="_blank" rel="noreferrer">
              פתיחה בחלון חדש
              <span aria-hidden="true">↗</span>
            </a>
          </div>

          <iframe
            key={activeProjectData.id}
            className="project-frame"
            src={activeProjectData.path}
            title={activeProjectData.frameTitle}
            allow="autoplay"
          />
        </article>
      )}
    </section>
  );
}
