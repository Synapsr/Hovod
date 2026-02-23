import { useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { useT } from '../lib/i18n/index.js';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  maxLength?: number;
}

export function RichTextEditor({ value, onChange, placeholder, maxLength }: RichTextEditorProps) {
  const { t } = useT();
  const effectivePlaceholder = placeholder ?? t.richText.placeholder;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [3] },
        codeBlock: false,
        code: false,
        blockquote: false,
        horizontalRule: false,
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'text-accent-400 underline underline-offset-2' },
      }),
      Placeholder.configure({ placeholder: effectivePlaceholder }),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // tiptap returns <p></p> for empty content
      const isEmpty = html === '<p></p>' || html === '';
      onChange(isEmpty ? '' : html);
    },
    editorProps: {
      attributes: {
        class: 'outline-none min-h-[80px] max-h-[200px] overflow-y-auto px-3 py-2 text-sm text-zinc-200 prose prose-sm prose-invert prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5',
      },
      handleKeyDown: maxLength ? (_view, event) => {
        // Allow backspace, delete, arrows, etc.
        if (['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'Enter'].includes(event.key)) return false;
        if (event.metaKey || event.ctrlKey) return false;
        const text = _view.state.doc.textContent;
        if (text.length >= maxLength && !_view.state.selection.empty) return false;
        if (text.length >= maxLength) return true;
        return false;
      } : undefined,
    },
  });

  const addLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href;
    const url = window.prompt('URL', prev || 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  }, [editor]);

  if (!editor) return null;

  const charCount = editor.state.doc.textContent.length;

  return (
    <div className="bg-zinc-800/60 border border-zinc-700/60 rounded-lg focus-within:border-zinc-500 transition-colors">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-zinc-700/40">
        <ToolbarButton
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title={t.richText.bold}
        >
          <span className="font-bold text-[11px]">B</span>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title={t.richText.italic}
        >
          <span className="italic text-[11px]">I</span>
        </ToolbarButton>
        <div className="w-px h-4 bg-zinc-700/40 mx-1" />
        <ToolbarButton
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title={t.richText.bulletList}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" />
            <circle cx="4" cy="6" r="1" fill="currentColor" /><circle cx="4" cy="12" r="1" fill="currentColor" /><circle cx="4" cy="18" r="1" fill="currentColor" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title={t.richText.numberedList}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="10" y1="6" x2="20" y2="6" /><line x1="10" y1="12" x2="20" y2="12" /><line x1="10" y1="18" x2="20" y2="18" />
            <text x="2" y="8" fontSize="8" fill="currentColor" stroke="none" fontFamily="system-ui">1</text>
            <text x="2" y="14" fontSize="8" fill="currentColor" stroke="none" fontFamily="system-ui">2</text>
            <text x="2" y="20" fontSize="8" fill="currentColor" stroke="none" fontFamily="system-ui">3</text>
          </svg>
        </ToolbarButton>
        <div className="w-px h-4 bg-zinc-700/40 mx-1" />
        <ToolbarButton
          active={editor.isActive('link')}
          onClick={addLink}
          title={t.richText.link}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </ToolbarButton>
        {maxLength && (
          <span className={`ml-auto text-[10px] tabular-nums ${charCount > maxLength * 0.9 ? 'text-amber-400' : 'text-zinc-600'}`}>
            {maxLength - charCount}
          </span>
        )}
      </div>

      {/* Editor */}
      <EditorContent editor={editor} />
    </div>
  );
}

/* ─── Toolbar button ──────────────────────────────────────── */

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`w-7 h-7 flex items-center justify-center rounded transition-colors cursor-pointer ${
        active
          ? 'bg-zinc-700 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/50'
      }`}
    >
      {children}
    </button>
  );
}
