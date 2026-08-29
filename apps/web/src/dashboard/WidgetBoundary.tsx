import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorBanner } from "../components/ui";

/**
 * One card's blast radius.
 *
 * The overview is now assembled from independently-written widgets, so a throw
 * in any one of them would otherwise blank the whole page — including the cards
 * that were working, and the toolbar you'd use to remove the broken one. React
 * has no hook form of this, hence the class.
 */
export class WidgetBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error(`Dashboard widget "${this.props.title}" crashed`, error, info);
    }

    render(): ReactNode {
        if (this.state.error) {
            return <ErrorBanner>This widget failed to render: {this.state.error.message}</ErrorBanner>;
        }
        return this.props.children;
    }
}
