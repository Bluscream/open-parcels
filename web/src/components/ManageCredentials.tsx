/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
import { createColumnHelper } from "@tanstack/react-table";
import { Key, Plus, Trash2, X, Edit } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { DataTable } from "./DataTable";

interface CredentialService {
	id: string;
	service: string;
	username?: string;
	updatedAt: string;
}

interface Props {
	token: string;
	credentialsList: CredentialService[];
	onRefresh: () => void;
}

export const ManageCredentials: React.FC<Props> = ({
	token,
	credentialsList,
	onRefresh,
}) => {
	const [showCredModal, setShowCredModal] = useState<boolean>(false);
	const [credForm, setCredForm] = useState({
		id: "",
		service: "IMAP",
		username: "",
		password: "",
		otpSecret: "",
		host: "",
		port: "",
		tls: "true",
	});

	const saveCredentials = async (e: React.FormEvent) => {
		e.preventDefault();
		const serviceName = credForm.service;

		let serviceData: Record<string, unknown>;
		if (serviceName === "IMAP") {
			serviceData = {
				username: credForm.username,
				password: credForm.password,
				host: credForm.host,
				port: parseInt(credForm.port || "993", 10),
				tls: credForm.tls === "true",
			};
		} else {
			serviceData = {
				username: credForm.username,
				password: credForm.password,
				otpSecret: credForm.otpSecret || null,
			};
		}

		try {
			const res = await fetch(`/api/v1/credentials?token=${token}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: credForm.id || undefined,
					service: serviceName,
					data: serviceData,
				}),
			});

			if (res.ok) {
				setShowCredModal(false);
				setCredForm({
					id: "",
					service: "IMAP",
					username: "",
					password: "",
					otpSecret: "",
					host: "",
					port: "",
					tls: "true",
				});
				onRefresh();
			}
		} catch (err) {
			console.error(err);
		}
	};

	const deleteCredentials = async (id: string) => {
		if (
			!confirm(
				"Are you sure you want to delete these credentials? modular scrapers for this service will stop working.",
			)
		)
			return;
		try {
			await fetch(`/api/v1/credentials/${id}?token=${token}`, {
				method: "DELETE",
			});
			onRefresh();
		} catch (err) {
			console.error(err);
		}
	};

	const editCredentials = async (id: string) => {
		try {
			const res = await fetch(`/api/v1/credentials/${id}?token=${token}`);
			if (res.ok) {
				const cred = await res.json();
				setCredForm({
					id: cred.id,
					service: cred.service,
					username: cred.data.username || "",
					password: cred.data.password || "",
					otpSecret: cred.data.otpSecret || "",
					host: cred.data.host || "",
					port: cred.data.port ? String(cred.data.port) : "",
					tls: cred.data.tls !== false ? "true" : "false",
				});
				setShowCredModal(true);
			} else {
				alert("Failed to load credentials for editing.");
			}
		} catch (err) {
			console.error(err);
		}
	};

	const ch = createColumnHelper<CredentialService>();
	const credColumns = [
		ch.accessor("service", {
			header: "Service",
			cell: info => (
				<span className="bold-cell" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
					<Key size={14} style={{ color: "#f59e0b" }} />
					{info.getValue()}
				</span>
			),
		}),
		ch.accessor("username", {
			header: "Account / Username",
			cell: info => info.getValue() || <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>None</span>,
		}),
		ch.accessor("updatedAt", {
			header: "Last Modified",
			cell: info => new Date(info.getValue()).toLocaleString(),
		}),
		ch.display({
			id: "actions",
			header: () => <span style={{ float: "right" }}>Actions</span>,
			cell: ({ row }) => (
				<div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
					<button className="btn-icon-sm" onClick={() => editCredentials(row.original.id)} title="Edit">
						<Edit size={14} />
					</button>
					<button className="btn-icon-sm text-red" onClick={() => deleteCredentials(row.original.id)} title="Delete">
						<Trash2 size={14} />
					</button>
				</div>
			),
			enableSorting: false,
			meta: { headerStyle: { textAlign: "right" } },
		}),
	];

	return (
		<>
			{/* CREDENTIALS TABLE */}
			<div className="glass-panel" style={{ padding: "24px" }}>
				<div className="panel-header-actions">
					<h3 className="panel-title" style={{ margin: 0 }}>
						Scraper Service Credentials
					</h3>
					<button className="btn btn-primary btn-sm" onClick={() => {
						setCredForm({
							id: "",
							service: "IMAP",
							username: "",
							password: "",
							otpSecret: "",
							host: "",
							port: "",
							tls: "true",
						});
						setShowCredModal(true);
					}}>
						<Plus size={14} /> Setup Service
					</button>
				</div>
				<DataTable
					columns={credColumns}
					data={credentialsList}
					emptyText="No scraper credentials stored. Modular scrapers will use defaults or skip."
					emptySearchText="No credentials match your search."
					searchPlaceholder="Search service…"
					defaultSortId="service"
					defaultSortDesc={false}
				/>
			</div>

			{/* Credentials Form Modal */}
			{showCredModal && (
				<div className="modal-overlay">
					<div className="glass-panel modal-card">
						<div className="modal-header">
							<h3>Setup Service Credentials</h3>
							<button
								className="btn-icon-sm"
								onClick={() => setShowCredModal(false)}
							>
								<X size={16} />
							</button>
						</div>
						<form onSubmit={saveCredentials}>
							<div className="modal-body">
								<div className="form-group">
									<label className="label">Service Name *</label>
									<select
										className="select"
										value={credForm.service}
										onChange={(e) =>
											setCredForm({ ...credForm, service: e.target.value })
										}
									>
										<option value="IMAP">Email Ingestion (IMAP)</option>
										<option value="Amazon">Amazon.de/com Scraper</option>
										<option value="eBay">eBay.de/com Scraper</option>
										<option value="AliExpress">AliExpress Scraper</option>
										<option value="Wish">Wish Scraper</option>
										<option value="Temu">Temu Scraper</option>
									</select>
								</div>

								<div className="form-group">
									<label className="label">Username/Email *</label>
									<input
										type="text"
										className="input"
										value={credForm.username}
										onChange={(e) =>
											setCredForm({ ...credForm, username: e.target.value })
										}
										required
										placeholder="Username or email address"
									/>
								</div>

								<div className="form-group">
									<label className="label">Password/Secret key *</label>
									<input
										type="password"
										className="input"
										value={credForm.password}
										onChange={(e) =>
											setCredForm({ ...credForm, password: e.target.value })
										}
										required
										placeholder="Enter password/app-token"
									/>
								</div>

								{credForm.service !== "IMAP" && (
									<div className="form-group">
										<label className="label">
											TOTP Secret Key (2FA) - Optional
										</label>
										<input
											type="text"
											className="input"
											value={credForm.otpSecret}
											onChange={(e) =>
												setCredForm({ ...credForm, otpSecret: e.target.value })
											}
											placeholder="e.g. JBSWY3DPEHPK3PXP"
										/>
									</div>
								)}

								{credForm.service === "IMAP" && (
									<>
										<div className="form-group">
											<label className="label">IMAP Host *</label>
											<input
												type="text"
												className="input"
												value={credForm.host}
												onChange={(e) =>
													setCredForm({ ...credForm, host: e.target.value })
												}
												required
												placeholder="e.g. imap.gmail.com"
											/>
										</div>
										<div className="form-row">
											<div className="form-group" style={{ flex: 1 }}>
												<label className="label">Port *</label>
												<input
													type="number"
													className="input"
													value={credForm.port}
													onChange={(e) =>
														setCredForm({ ...credForm, port: e.target.value })
													}
													required
													placeholder="e.g. 993"
												/>
											</div>
											<div className="form-group" style={{ flex: 1 }}>
												<label className="label">Use TLS</label>
												<select
													className="select"
													value={credForm.tls}
													onChange={(e) =>
														setCredForm({ ...credForm, tls: e.target.value })
													}
												>
													<option value="true">Yes</option>
													<option value="false">No</option>
												</select>
											</div>
										</div>
									</>
								)}
							</div>
							<div className="modal-footer">
								<button
									type="button"
									className="btn"
									onClick={() => setShowCredModal(false)}
								>
									Cancel
								</button>
								<button type="submit" className="btn btn-primary">
									Save Credentials
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</>
	);
};
