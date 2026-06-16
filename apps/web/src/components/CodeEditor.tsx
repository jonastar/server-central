import { lazy, Suspense, useMemo } from "react";

const MonacoPane = lazy(() => import("./MonacoPane"));

/**
 * Monaco on desktop, plain textarea on mobile/coarse-pointer devices where
 * monaco is unusable.
 */
export function CodeEditor({ path, value, onChange, onSave }: {
    path: string;
    value: string;
    onChange: (value: string) => void;
    onSave: () => void;
}) {
    const useBasicEditor = useMemo(
        () => window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768,
        [],
    );

    if (useBasicEditor) {
        return (
            <textarea
                className="editor-textarea"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                spellCheck={false}
                onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                        e.preventDefault();
                        onSave();
                    }
                }}
            />
        );
    }

    return (
        <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
            <MonacoPane path={path} value={value} onChange={onChange} onSave={onSave} />
        </Suspense>
    );
}
