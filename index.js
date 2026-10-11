/**
 * Host half of dsh-sidebar-focus.
 *
 * The bundle is client-only: every rule reads the sidebar's own DOM contract and the workspace
 * browser's view store, both of which live in the Web page. This half exists so the bundle has a
 * Host row the Loader can mount, and deliberately touches nothing.
 */
export function apply() {}
