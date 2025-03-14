import { Injectable } from '@angular/core';

@Injectable({
  	providedIn: 'root'
})
export class ViewingService {

	private HELPERS_KEY = "helpers";
	private helpersDisabled: boolean;

	private TITLES_KEY = "titles";
	private titlesHidden: boolean;

	private TECHNOLOGIES_KEY = "technologies";
	private technologiesHidden: boolean;

	private DARKMODE_KEY = "darkmode"
	private darkModeEnabled: boolean;

	constructor() { 
		this.helpersDisabled = localStorage.getItem(this.HELPERS_KEY) == "true" ? true : false;
		this.titlesHidden = localStorage.getItem(this.TITLES_KEY) == "true" ? true : false;
		this.technologiesHidden = localStorage.getItem(this.TECHNOLOGIES_KEY) == "true" ? true : false;
		this.darkModeEnabled = localStorage.getItem(this.DARKMODE_KEY) == "true" ? true : false;
	}

	isHelpersDisabled(){
		return this.helpersDisabled;
	}

	setHelpersDisabled(disabled: boolean = true){
		localStorage.setItem(this.HELPERS_KEY, disabled.toString());
		this.helpersDisabled = disabled;
	}

	isTitlesHidden(){
		return this.titlesHidden;
	}

	setTitlesHidden(hidden: boolean = true, saveToLocalStorage: boolean = true){
		if(saveToLocalStorage)
			localStorage.setItem(this.TITLES_KEY, hidden.toString());
		this.titlesHidden = hidden;
	}

	isTechnologiesHidden(){
		return this.technologiesHidden;
	}

	setTechnologiesHidden(hidden: boolean = true, saveToLocalStorage: boolean = true){
		if(saveToLocalStorage)
			localStorage.setItem(this.TECHNOLOGIES_KEY, hidden.toString());
		this.technologiesHidden = hidden;
	}

	isDarkMode(){
		return this.darkModeEnabled;
	}

	setDarkMode(enabled: boolean = true, saveToLocalStorage: boolean = true){
		if(saveToLocalStorage)
			localStorage.setItem(this.DARKMODE_KEY, enabled.toString());
		if(enabled)
			document.documentElement.classList.add("dark-mode");
		else 
			document.documentElement.classList.remove("dark-mode");
		this.darkModeEnabled = enabled;
	}
}