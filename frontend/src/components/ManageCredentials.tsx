/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
import { Key, Plus, Trash2, X } from "lucide-react";
import type React from "react";
import { useState } from "react";

interface CredentialService {
	id: number;
	service: string;
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
				body: JSON.stringify({ service: serviceName, data: serviceData }),
			});

			if (res.ok) {
				setShowCredModal(false);
				setCredForm({
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

	const deleteCredentials = async (id: number) => {
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

	return (
		<>
			{/* CREDENTIALS TABLE */}
			<div className="glass-panel">
				<div className="panel-header-actions">
					<h3 className="panel-title" style={{ margin: 0 }}>
						{" "}
						modular Scrapers Credentials
					</h3>
					<button
						className="btn btn-primary btn-sm"
						onClick={() => setShowCredModal(true)}
					>
						<Plus size={14} /> Setup Service
					</button>
				</div>

				<div className="table-wrapper">
					<table className="table">
						<thead>
							<tr>
								<th>Service</th>
								<th>Last Modified</th>
								<th style={{ textAlign: "right" }}>Actions</th>
							</tr>
						</thead>
						<tbody>
							{credentialsList.map((cred) => (
								<tr key={cred.id}>
									<td
										className="bold-cell"
										style={{
											display: "flex",
											alignItems: "center",
											gap: "8px",
										}}
									>
										<Key size={14} className="text-yellow-400" />
										{cred.service}
									</td>
									<td>{new Date(cred.updatedAt).toLocaleString()}</td>
									<td style={{ textAlign: "right" }}>
										<button
											className="btn-icon-sm text-red"
											onClick={() => deleteCredentials(cred.id)}
										>
											<Trash2 size={14} />
										</button>
									</td>
								</tr>
							))}
							{credentialsList.length === 0 && (
								<tr>
									<td
										colSpan={3}
										style={{ textAlign: "center", padding: "32px" }}
										className="text-muted"
									>
										No scraper credentials stored. Modular scrapers will use
										defaults or skip.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
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
