import type React from "react";
import { Panel, Group, Separator } from "react-resizable-panels";

interface SplitContainerProps {
	leftPanel: React.ReactNode;
	rightPanel: React.ReactNode;
	leftDefaultSize?: number;
	rightDefaultSize?: number;
	leftMinSize?: number;
	rightMinSize?: number;
}

export const SplitContainer: React.FC<SplitContainerProps> = ({
	leftPanel,
	rightPanel,
	leftDefaultSize = 40,
	rightDefaultSize = 60,
	leftMinSize = 20,
	rightMinSize = 30,
}) => {
	return (
		<Group orientation="horizontal" style={{ height: "100%", width: "100%" }}>
			<Panel defaultSize={leftDefaultSize} minSize={leftMinSize}>
				{leftPanel}
			</Panel>

			<Separator
				style={{
					width: "24px",
					cursor: "col-resize",
					position: "relative",
					display: "flex",
					justifyContent: "center",
					alignItems: "center",
					zIndex: 10,
				}}
			>
				<div
					style={{
						position: "absolute",
						width: "4px",
						height: "24px",
						background: "rgba(255,255,255,0.2)",
						borderRadius: "2px",
					}}
				/>
			</Separator>

			<Panel defaultSize={rightDefaultSize} minSize={rightMinSize}>
				{rightPanel}
			</Panel>
		</Group>
	);
};
