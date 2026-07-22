// Ambient module for Bun's `with { type: "text" }` import assertion, used to
// statically embed text assets (e.g. bootstrap.sh) into `bun build --compile` binaries.
declare module "*.sh" {
    const content: string;
    export default content;
}
