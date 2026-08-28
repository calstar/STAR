// Adds a parallel `@modal` slot so an intercepted task-detail route can render
// as a modal over the board while the board stays mounted underneath.
export default function ProjectLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
