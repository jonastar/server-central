import { useEffect, useRef } from "react";
import "../monaco-setup";
import Editor from "@monaco-editor/react";

export default function MonacoPane({ path, value, onChange, onSave }: {
    path: string;
    value: string;
    onChange: (value: string) => void;
    onSave: () => void;
}) {
    const onSaveRef = useRef(onSave);
    useEffect(() => {
        onSaveRef.current = onSave;
    }, [onSave]);

    return (
        <Editor
            path={path}
            value={value}
            theme="light"
            onChange={(v) => onChange(v ?? "")}
            options={{
                minimap: { enabled: false },
                fontSize: 13,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderWhitespace: "none",
            }}
            onMount={(editor, monaco) => {
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
            }}
        />
    );
}
